import { GoogleGenerativeAI } from "@google/generative-ai";
import { json } from "@remix-run/node";
import { useActionData, useLoaderData, useNavigation, useSubmit } from "@remix-run/react";
import { Badge, Banner, BlockStack, Button, Card, FormLayout, InlineStack, Page, Select, Spinner, Tabs, Text, Thumbnail } from "@shopify/polaris";
import { useEffect, useState } from "react";
import db from "../db.server";
import { authenticate } from "../shopify.server";

// ========== SEMANTIC SEARCH UTILITIES ==========

/**
 * @param {string} text - The text to convert to embedding
 * @param {GoogleGenerativeAI} genAI - Initialized Gemini AI client
 * @returns {Promise<number[]>} - The embedding vector
 */
async function generateEmbedding(text, genAI) {
  try {
    const model = genAI.getGenerativeModel({ model: "text-embedding-004" });
    const result = await model.embedContent(text);
    return result.embedding.values;
  } catch (error) {
    console.error("Embedding generation error:", error.message);
    return null;
  }
}

/**
 * Calculate cosine similarity between two vectors
 * @param {number[]} vecA - First vector
 * @param {number[]} vecB - Second vector
 * @returns {number} - Similarity score between -1 and 1 (higher = more similar)
 */
function calculateCosineSimilarity(vecA, vecB) {
  if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
  
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Build a searchable text representation of a product
 * @param {object} product - Product object with title, tags, description, etc.
 * @returns {string} - Combined text for embedding
 */
function buildProductSearchText(product) {
  const parts = [];
  
  // Add title (most important)
  if (product.title) parts.push(product.title);
  
  // Add description (strip HTML tags)
  if (product.description) {
    const cleanDescription = product.description
      .replace(/<[^>]*>/g, ' ')  // Remove HTML tags
      .replace(/\s+/g, ' ')       // Normalize whitespace
      .trim();
    parts.push(cleanDescription);
  }
  
  // Add tags
  if (product.tags && product.tags.length > 0) {
    parts.push(product.tags.join(" "));
  }
  
  // Add product type/category
  if (product.productType) parts.push(product.productType);
  
  // Add vendor/brand
  if (product.vendor) parts.push(product.vendor);
  
  // Add options (like Color, Size, Material)
  if (product.options && product.options.length > 0) {
    const optionText = product.options
      .map(opt => `${opt.name}: ${(opt.values || []).join(', ')}`)
      .join(' ');
    parts.push(optionText);
  }
  
  return parts.join(' ').trim();
}

// ==============================================

export const loader = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  const response = await admin.graphql(
    `#graphql
      query getProducts {
        products(first: 250) {
          edges {
            node {
              id
              title
              description
              descriptionHtml
              vendor
              productType
              tags
              totalInventory
              options {
                name
                values
              }
              priceRangeV2 {
                minVariantPrice {
                  amount
                  currencyCode
                }
              }
            }
          }
        }
      }
    `
  );

  const responseJson = await response.json();
  const products = responseJson.data.products.edges.map(edge => edge.node);

  const simplifiedProducts = products
    .filter(product => product.totalInventory > 0)
    .map(product => ({
      id: product.id,
      title: product.title,
      tags: Array.isArray(product.tags)
        ? product.tags
        : (product.tags || "").toString().split(',').map(t => t.trim()).filter(Boolean),
      price: parseFloat(product.priceRangeV2.minVariantPrice.amount),
      inventory: product.totalInventory
    }));

  // Fetch recommendation history
  const history = await db.outfitRecommendation.findMany({
    where: {
      shop: session.shop
    },
    orderBy: {
      createdAt: 'desc'
    },
    take: 5
  });

  return json({ products: simplifiedProducts, history });
};

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);
  
  const formData = await request.formData();
  const budget = formData.get("budget");
  const style = formData.get("style");
  const occasion = formData.get("occasion");
  const weather = formData.get("weather");

  const response = await admin.graphql(
    `#graphql
      query getProducts {
        products(first: 250) {
          edges {
            node {
              id
              title
              description
              descriptionHtml
              vendor
              productType
              tags
              totalInventory
              options {
                name
                values
              }
              priceRangeV2 {
                minVariantPrice {
                  amount
                  currencyCode
                }
              }
              featuredImage {
                url
              }
            }
          }
        }
      }
    `
  );

  const responseJson = await response.json();
  const rawProducts = responseJson.data.products.edges.map(edge => edge.node);

  const products = rawProducts.map(product => ({
    id: product.id,
    title: product.title,
    description: product.description || product.descriptionHtml || "",
    vendor: product.vendor || "",
    productType: product.productType || "",
    options: product.options || [],
    price: parseFloat(product.priceRangeV2.minVariantPrice.amount),
    image: product.featuredImage?.url || null,
    tags: Array.isArray(product.tags)
      ? product.tags
      : (product.tags || "").toString().split(',').map(t => t.trim()).filter(Boolean),
    inventory: product.totalInventory
  }));

  // Determine budget range
  let maxPrice;
  if (budget === "Under 50") {
    maxPrice = 50;
  } else if (budget === "50-100") {
    maxPrice = 100;
  } else {
    maxPrice = Infinity;
  }

  // Allow some leeway above the selected budget so AI can choose slightly higher-quality options
  const allowedMaxPrice = maxPrice === Infinity ? Infinity : Math.ceil(maxPrice * 1.25);

  // Filter products based on budget and availability only
  const budgetFilteredProducts = products.filter(product => {
    if (product.inventory <= 0) return false;
    if (product.price > allowedMaxPrice) return false;
    return true;
  });

  const preferences = {
    budget,
    style,
    occasion,
    weather
  };

  // If no products match budget, return early
  if (budgetFilteredProducts.length === 0) {
    return json({
      preferences,
      recommendation: null,
      colorPalette: [],
      products: [],
      error: "No products found within your budget. Try increasing your budget."
    });
  }

  // Initialize Gemini AI client
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

  // ========== SEMANTIC SEARCH: Rank products by similarity to user preferences ==========
  // Build user preference query for semantic matching
  const userPreferenceQuery = `${style} ${occasion} outfit for ${weather} weather`;
  
  // Generate embedding for user preferences
  const userEmbedding = await generateEmbedding(userPreferenceQuery, genAI);
  
  let filteredProducts = budgetFilteredProducts;
  
  if (userEmbedding) {
    // Generate embeddings for all products and calculate similarity scores
    const productsWithScores = await Promise.all(
      budgetFilteredProducts.map(async (product) => {
        const productText = buildProductSearchText(product);
        const productEmbedding = await generateEmbedding(productText, genAI);
        const similarity = calculateCosineSimilarity(userEmbedding, productEmbedding);
        return { ...product, similarityScore: similarity };
      })
    );
    
    // Sort products by similarity score (highest first)
    productsWithScores.sort((a, b) => b.similarityScore - a.similarityScore);
    
    // Log top matches for debugging
    console.log("Top semantic matches:", productsWithScores.slice(0, 5).map(p => ({
      title: p.title,
      score: p.similarityScore.toFixed(4)
    })));
    
    // Use semantically sorted products
    filteredProducts = productsWithScores;
  }

  // Build AI stylist prompt using top semantically-matched products
  const topProducts = filteredProducts.slice(0, 20); // Limit to top 20 for AI context
  const productsListText = topProducts.map((product, index) => {
    const scoreText = product.similarityScore ? ` (relevance: ${(product.similarityScore * 100).toFixed(0)}%)` : '';
    return `${index + 1}. ${product.title}${scoreText}\n   Price: $${product.price.toFixed(2)}\n   Tags: ${product.tags.join(", ")}`;
  }).join("\n\n");

  const aiPrompt = `🎨 You are an elite fashion consultant with years of experience in personal styling.

✨ CLIENT PROFILE:
💰 Budget: ${budget}
📏 Size: ${formData.get("size")}
👔 Style Preference: ${style}
🎯 Occasion: ${occasion}
🌤️ Weather: ${weather}

🛍️ CURATED PRODUCT COLLECTION:
${productsListText}

🎯 YOUR MISSION:
Create a stunning, cohesive outfit that makes the client feel confident and stylish!

1️⃣ SELECT 2-5 COMPLEMENTARY PIECES:
   - Choose items that work harmoniously together
   - Ensure they're perfect for ${style} vibes at ${occasion} in ${weather} weather
   - Consider versatility and mix-match potential

2️⃣ CRAFT YOUR STYLING STORY:
   - Explain the fashion narrative behind your choices
   - Highlight why these pieces elevate the client's style
   - Share the emotional impact and confidence boost
   - Use conversational, inspiring language

3️⃣ DESIGN A COLOR HARMONY:
   - Suggest 3-4 colors that create a cohesive palette
   - Think beyond basic - be specific (e.g., "Midnight Navy", "Warm Caramel", "Soft Ivory")
   - Consider undertones and skin tone flattery

4️⃣ SHARE INSIDER STYLING SECRETS:
   - Pro tips on how to wear and accessorize
   - Styling hacks for maximum impact
   - Occasion-specific advice

⚠️ CRITICAL: Use EXACT product titles from the list above in recommended_titles.

📦 RESPONSE FORMAT (JSON ONLY):
{
  "recommendation_text": "Your creative, inspiring styling story here...",
  "color_palette": ["Sophisticated color 1", "Elegant color 2", "Refined color 3"],
  "recommended_titles": ["Exact Product Title 1", "Exact Product Title 2"]
}

💡 Tone: Warm, enthusiastic, and empowering - like chatting with a trusted style-savvy friend!`;

// console.log("AI Prompt:", aiPrompt); // removed debug log
  
  const model = genAI.getGenerativeModel({
    model: "gemini-2.5-flash",
  });

  const result = await model.generateContent(`
You must respond ONLY in valid JSON.

Return the response in this exact format:
{
  "recommendation_text": "string",
  "color_palette": ["string", "string", "string"],
  "recommended_titles": ["product title", "product title"]
}

${aiPrompt}
`);

  const aiText = result.response.text();

  let aiResult;
  try {
    // Clean JSON response - remove markdown code blocks if present
    let cleanedText = aiText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    aiResult = JSON.parse(cleanedText);
  } catch (error) {
    // Try to extract JSON from the response
    const jsonMatch = aiText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        aiResult = JSON.parse(jsonMatch[0]);
      } catch {
        aiResult = {
          recommendation_text: aiText,
          color_palette: [],
          recommended_titles: [],
        };
      }
    } else {
      aiResult = {
        recommendation_text: aiText,
        color_palette: [],
        recommended_titles: [],
      };
    }
  }

  // Match AI-chosen titles to actual products (case-insensitive, partial match)
  // Match AI-chosen titles to actual products using exact (case-insensitive) title matching
  const requestedTitles = (aiResult.recommended_titles || [])
    .map(t => (t || "").trim())
    .filter(Boolean)
    .map(t => t.toLowerCase());

  // Use a map to collect unique matches by product id
  const matchesById = new Map();
  for (const titleLower of requestedTitles) {
    const match = filteredProducts.find(p => p.title.toLowerCase() === titleLower);
    if (match && !matchesById.has(match.id)) {
      matchesById.set(match.id, match);
    }
  }

  // If the AI returned titles but we didn't find exact matches, try a relaxed fallback (partial match)
  if (matchesById.size === 0 && requestedTitles.length > 0) {
    for (const titleLower of requestedTitles) {
      for (const p of filteredProducts) {
        const pt = p.title.toLowerCase();
        if (pt.includes(titleLower) || titleLower.includes(pt)) {
          if (!matchesById.has(p.id)) matchesById.set(p.id, p);
        }
      }
    }
  }

  // Build an ordered array of unique recommended products
  let recommendedProducts = Array.from(matchesById.values());

  // If AI couldn't match any titles, fall back to top semantically-matched products
  if (recommendedProducts.length === 0) {
    // Use semantic similarity scores if available, otherwise fall back to tag matching
    if (filteredProducts[0]?.similarityScore !== undefined) {
      // Already sorted by similarity, take top 3
      recommendedProducts = filteredProducts.slice(0, 3);
    } else {
      // Fallback: Prefer products that match at least one preference tag (style/occasion/weather)
      const prefKeywords = [style, occasion, weather].map(k => (k || "").toLowerCase());
      const scored = filteredProducts.map(p => {
        const tags = (p.tags || []).map(t => t.toLowerCase());
        const score = prefKeywords.reduce((s, kw) => s + (tags.some(t => t.includes(kw)) ? 1 : 0), 0);
        return { p, score };
      });
      scored.sort((a, b) => b.score - a.score || a.p.price - b.p.price);
      recommendedProducts = scored.slice(0, 3).map(s => s.p);
    }
  }

  // Ensure uniqueness and limit to max 3 products
  const uniqueById = [];
  const seen = new Set();
  for (const p of recommendedProducts) {
    if (seen.has(p.id)) continue;
    uniqueById.push(p);
    seen.add(p.id);
    if (uniqueById.length >= 5) break;
  }

  const finalProducts = uniqueById;

  // Save to database
  try {
    await db.outfitRecommendation.create({
      data: {
        shop: session.shop,
        userPreferences: JSON.stringify({
          budget,
          size: formData.get("size"),
          style,
          occasion,
          weather
        }),
        aiAdvice: aiResult.recommendation_text,
        productIds: finalProducts.map(p => p.id).join(",")
      }
    });
  } catch (dbError) {
    console.error("Failed to save outfit recommendation:", dbError);
    // Continue despite database error - user still gets their recommendation
  }

  return json({
    preferences,
    recommendation: aiResult.recommendation_text,
    colorPalette: aiResult.color_palette || [],
    products: finalProducts,
    error: null
  });
};

export default function Index() {
  const { products, history } = useLoaderData();
  const actionData = useActionData();
  const submit = useSubmit();
  const navigation = useNavigation();
  const [mounted, setMounted] = useState(false);
  const [selectedTab, setSelectedTab] = useState(0);
  
  const isLoading = navigation.state === "submitting";
  
  const [budget, setBudget] = useState("50-100");
  const [size, setSize] = useState("M");
  const [style, setStyle] = useState("Casual");
  const [occasion, setOccasion] = useState("Daily");
  const [weather, setWeather] = useState("Hot");
  
  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    if (mounted) {
      console.log("Products:", products);
    }
  }, [mounted, products]);

  const handleSubmit = () => {
    const formData = new FormData();
    formData.append("budget", budget);
    formData.append("size", size);
    formData.append("style", style);
    formData.append("occasion", occasion);
    formData.append("weather", weather);
    
    submit(formData, { method: "POST" });
  };

  const handleRestore = (userPreferences) => {
    const preferences = JSON.parse(userPreferences);
    setBudget(preferences.budget);
    setSize(preferences.size);
    setStyle(preferences.style);
    setOccasion(preferences.occasion);
    setWeather(preferences.weather);
    setSelectedTab(0); // Switch to Generator tab
  };

  if (!mounted) {
    return null;
  }

  const tabs = [
    {
      id: 'generator',
      content: 'Generator',
      panelID: 'generator-panel',
    },
    {
      id: 'history',
      content: 'History',
      panelID: 'history-panel',
    },
  ];

  return (
    <Page title="Outfit Recommendation Generator">
      <Tabs tabs={tabs} selected={selectedTab} onSelect={setSelectedTab}>
        {selectedTab === 0 && (
          <BlockStack gap="500">
            <Card>
              <FormLayout>
                <Select
                  label="Budget"
                  options={[
                    { label: "Under 50", value: "Under 50" },
                    { label: "50-100", value: "50-100" },
                    { label: "100+", value: "100+" },
                  ]}
                  value={budget}
                  onChange={setBudget}
                />
                <Select
                  label="Size"
                  options={[
                    { label: "S", value: "S" },
                    { label: "M", value: "M" },
                    { label: "L", value: "L" },
                    { label: "XL", value: "XL" },
                  ]}
                  value={size}
                  onChange={setSize}
                />
                <Select
                  label="Style"
                  options={[
                    { label: "Casual", value: "Casual" },
                    { label: "Formal", value: "Formal" },
                    { label: "Athleisure", value: "Athleisure" },
                  ]}
                  value={style}
                  onChange={setStyle}
                />
                <Select
                  label="Occasion"
                  options={[
                    { label: "Work", value: "Work" },
                    { label: "Party", value: "Party" },
                    { label: "Travel", value: "Travel" },
                    { label: "Daily", value: "Daily" },
                  ]}
                  value={occasion}
                  onChange={setOccasion}
                />
                <Select
                  label="Weather"
                  options={[
                    { label: "Hot", value: "Hot" },
                    { label: "Cold", value: "Cold" },
                    { label: "Rainy", value: "Rainy" },
                    { label: "Mild", value: "Mild" },
                  ]}
                  value={weather}
                  onChange={setWeather}
                />
                <Button variant="primary" onClick={handleSubmit} loading={isLoading}>
                  {isLoading ? "Generating..." : "Generate Outfit"}
                </Button>
              </FormLayout>
            </Card>

            {isLoading && (
              <Card>
                <BlockStack gap="400" align="center">
                  <Spinner size="large" />
                  <Text as="p" variant="bodyMd">
                    AI is analyzing your preferences and creating outfit recommendations...
                  </Text>
                </BlockStack>
              </Card>
            )}

            {actionData?.error && (
              <Banner tone="warning">
                <p>{actionData.error}</p>
              </Banner>
            )}

            {actionData?.recommendation && !isLoading && (
              <Card>
                <BlockStack gap="500">
                  <BlockStack gap="300">
                    <Text as="h2" variant="headingLg" fontWeight="bold">
                      ✨ Your Personalized Style Guide
                    </Text>
                    <div style={{ 
                      padding: '16px', 
                      background: 'linear-gradient(135deg, #f5f7fa 0%, #cfcfcf 100%)',
                      borderRadius: '12px',
                      borderLeft: '2px solid #5C6AC4'
                    }}>
                      <Text as="p" variant="bodyLg">
                        {actionData.recommendation}
                      </Text>
                    </div>
                  </BlockStack>
                  
                  {actionData.colorPalette && actionData.colorPalette.length > 0 && (
                    <BlockStack gap="300">
                      <Text as="h3" variant="headingMd" fontWeight="semibold">
                        🎨 Your Color Palette
                      </Text>
                      <div style={{ 
                        padding: '12px',
                        background: '#FAFBFC',
                        borderRadius: '8px'
                      }}>
                        <InlineStack gap="300" wrap={true}>
                          {actionData.colorPalette.map((color, index) => (
                            <div key={index} style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '8px',
                              padding: '8px 16px',
                              background: 'white',
                              borderRadius: '20px',
                              boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
                            }}>
                              <div style={{
                                width: '20px',
                                height: '20px',
                                borderRadius: '50%',
                                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                                border: '2px solid #E4E5E7'
                              }} />
                              <Text as="span" variant="bodySm" fontWeight="medium">
                                {color}
                              </Text>
                            </div>
                          ))}
                        </InlineStack>
                      </div>
                    </BlockStack>
                  )}
                </BlockStack>
              </Card>
            )}
            
            {actionData?.products && actionData.products.length > 0 && !isLoading && (
              <Card>
                <BlockStack gap="500">
                  <BlockStack gap="200">
                    <Text as="h2" variant="headingLg" fontWeight="bold">
                      🛍️ Your Curated Selection
                    </Text>
                    <Text as="p" variant="bodySm" tone="subdued">
                      {actionData.products.length} perfectly matched {actionData.products.length === 1 ? 'item' : 'items'} for your style
                    </Text>
                  </BlockStack>
                  {actionData.products.map((product, index) => (
                    <Card key={product.id}>
                      <div style={{
                        padding: '4px',
                        background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                        borderRadius: '12px'
                      }}>
                        <div style={{
                          padding: '16px',
                          background: 'white',
                          borderRadius: '10px'
                        }}>
                          <InlineStack gap="400" align="start">
                            <div style={{ position: 'relative' }}>
                              <Thumbnail
                                source={product.image || "https://cdn.shopify.com/s/files/1/0533/2089/files/placeholder-images-image_large.png"}
                                alt={product.title}
                                size="large"
                              />
                              <div style={{
                                position: 'absolute',
                                top: '-8px',
                                left: '-8px',
                                width: '28px',
                                height: '28px',
                                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                                borderRadius: '50%',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                color: 'white',
                                fontWeight: 'bold',
                                fontSize: '14px',
                                boxShadow: '0 2px 4px rgba(0,0,0,0.2)'
                              }}>
                                {index + 1}
                              </div>
                            </div>
                            <BlockStack gap="300">
                              <Text as="h3" variant="headingMd" fontWeight="semibold">
                                {product.title}
                              </Text>
                              <div style={{
                                display: 'inline-block',
                                padding: '6px 12px',
                                background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                                borderRadius: '6px',
                                color: 'white',
                                fontWeight: 'bold',
                                fontSize: '16px'
                              }}>
                                ${product.price.toFixed(2)}
                              </div>
                              {product.tags && product.tags.length > 0 && (
                                <InlineStack gap="100" wrap={true}>
                                  {product.tags.slice(0, 5).map((tag, tagIndex) => (
                                    <Badge key={tagIndex} tone="info">{tag}</Badge>
                                  ))}
                                </InlineStack>
                              )}
                            </BlockStack>
                          </InlineStack>
                        </div>
                      </div>
                    </Card>
                  ))}
                </BlockStack>
              </Card>
            )}
            
            {actionData?.products && actionData.products.length === 0 && !actionData?.error && !isLoading && (
              <Card>
                <Text as="p" variant="bodyMd">
                  No products found matching your preferences. Try adjusting your filters.
                </Text>
              </Card>
            )}
          </BlockStack>
        )}

        {selectedTab === 1 && (
          <BlockStack gap="500">
            {history && history.length > 0 ? (
              history.map((item) => {
                const preferences = JSON.parse(item.userPreferences);
                const formattedDate = new Date(item.createdAt).toLocaleString();
                
                return (
                  <Card key={item.id}>
                    <BlockStack gap="400">
                      <InlineStack align="space-between">
                        <Text as="h3" variant="headingMd">
                          📅 {formattedDate}
                        </Text>
                        <InlineStack gap="200">
                          <Badge>{preferences.style}</Badge>
                          <Badge>{preferences.occasion}</Badge>
                          <Badge>{preferences.weather}</Badge>
                          <Button size="slim" onClick={() => handleRestore(item.userPreferences)}>
                            Restore
                          </Button>
                        </InlineStack>
                      </InlineStack>
                      
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          Preferences:
                        </Text>
                        <Text as="p" variant="bodySm" tone="subdued">
                          Budget: {preferences.budget} | Size: {preferences.size} | Style: {preferences.style} | Occasion: {preferences.occasion} | Weather: {preferences.weather}
                        </Text>
                      </BlockStack>
                      
                      <BlockStack gap="200">
                        <Text as="p" variant="bodyMd" fontWeight="semibold">
                          AI Recommendation:
                        </Text>
                        <Text as="p" variant="bodySm">
                          {item.aiAdvice}
                        </Text>
                      </BlockStack>
                      
                      {item.productIds && (
                        <BlockStack gap="200">
                          <Text as="p" variant="bodyMd" fontWeight="semibold">
                            Recommended Products ({item.productIds.split(',').length}):
                          </Text>
                          <Text as="p" variant="bodySm" tone="subdued">
                            {item.productIds.split(',').map(id => id.split('/').pop()).join(', ')}
                          </Text>
                        </BlockStack>
                      )}
                    </BlockStack>
                  </Card>
                );
              })
            ) : (
              <Card>
                <BlockStack gap="400" align="center">
                  <Text as="p" variant="bodyMd" tone="subdued">
                    No recommendation history yet. Generate your first outfit recommendation to see it here!
                  </Text>
                </BlockStack>
              </Card>
            )}
          </BlockStack>
        )}
      </Tabs>
    </Page>
  );
}

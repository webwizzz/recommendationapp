-- CreateTable
CREATE TABLE "OutfitRecommendation" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "userPreferences" TEXT NOT NULL,
    "aiAdvice" TEXT NOT NULL,
    "productIds" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

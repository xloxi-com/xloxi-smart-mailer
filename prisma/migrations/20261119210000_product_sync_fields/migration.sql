-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "storefrontUrl" TEXT;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "inventoryPolicy" TEXT NOT NULL DEFAULT 'DENY';

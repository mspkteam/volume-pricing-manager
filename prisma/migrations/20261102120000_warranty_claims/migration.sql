-- CreateEnum
CREATE TYPE "WarrantyClaimStatus" AS ENUM ('PENDING', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'INVOICE_SENT', 'CLOSED');

-- CreateTable
CREATE TABLE "WarrantySettings" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "warrantyWindowDays" INTEGER NOT NULL DEFAULT 365,
    "shippingHandlingMinor" BIGINT NOT NULL DEFAULT 1500,
    "shippingHandlingTitle" TEXT NOT NULL DEFAULT 'Warranty replacement — shipping & handling',
    "requireLogin" BOOLEAN NOT NULL DEFAULT false,
    "requireOrderNumber" BOOLEAN NOT NULL DEFAULT true,
    "requirePurchaseDate" BOOLEAN NOT NULL DEFAULT true,
    "successMessage" TEXT NOT NULL DEFAULT 'Thanks — your warranty claim was received. We will review it and follow up soon.',
    "introHtml" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarrantySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WarrantyClaims" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "claimNumber" TEXT NOT NULL,
    "status" "WarrantyClaimStatus" NOT NULL DEFAULT 'PENDING',
    "shopifyCustomerId" TEXT,
    "customerName" TEXT,
    "customerEmail" TEXT NOT NULL,
    "customerPhone" TEXT,
    "companyName" TEXT,
    "productSku" TEXT NOT NULL,
    "productTitle" TEXT,
    "orderNumber" TEXT,
    "purchaseDate" TIMESTAMP(3),
    "issueDescription" TEXT NOT NULL,
    "attachmentUrls" JSONB NOT NULL DEFAULT '[]',
    "withinWarrantyWindow" BOOLEAN,
    "shippingInvoiceDraftOrderId" TEXT,
    "shippingInvoiceUrl" TEXT,
    "shippingAmountMinor" BIGINT,
    "customerMessage" TEXT,
    "internalNotes" TEXT NOT NULL DEFAULT '',
    "reviewHistory" JSONB NOT NULL DEFAULT '[]',
    "idempotencyKey" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WarrantyClaims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WarrantySettings_shopId_key" ON "WarrantySettings"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "WarrantyClaims_shopId_claimNumber_key" ON "WarrantyClaims"("shopId", "claimNumber");

-- CreateIndex
CREATE UNIQUE INDEX "WarrantyClaims_shopId_idempotencyKey_key" ON "WarrantyClaims"("shopId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "WarrantyClaims_shopId_status_submittedAt_idx" ON "WarrantyClaims"("shopId", "status", "submittedAt");

-- CreateIndex
CREATE INDEX "WarrantyClaims_shopId_customerEmail_idx" ON "WarrantyClaims"("shopId", "customerEmail");

-- CreateIndex
CREATE INDEX "WarrantyClaims_shopId_productSku_idx" ON "WarrantyClaims"("shopId", "productSku");

-- AddForeignKey
ALTER TABLE "WarrantySettings" ADD CONSTRAINT "WarrantySettings_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WarrantyClaims" ADD CONSTRAINT "WarrantyClaims_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

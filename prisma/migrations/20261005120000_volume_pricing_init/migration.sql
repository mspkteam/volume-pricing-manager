-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PricingSyncStatus" AS ENUM ('NOT_CONFIGURED', 'READY', 'SYNCING', 'SYNCED', 'FAILED', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "PricingCompatibility" AS ENUM ('UNKNOWN', 'SUPPORTED', 'UNSUPPORTED', 'SETUP_REQUIRED');

-- CreateEnum
CREATE TYPE "ImportStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETE', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "HistoryStatus" AS ENUM ('UNKNOWN', 'COMPLETE', 'INSUFFICIENT', 'PARTIAL');

-- CreateEnum
CREATE TYPE "AssignmentChangeType" AS ENUM ('CALCULATED', 'UPGRADE', 'DOWNGRADE', 'OVERRIDE_SET', 'OVERRIDE_EXPIRED', 'APPROVAL_CHANGE', 'MANUAL_REASSIGN', 'ARCHIVE_REASSIGN', 'GRACE_PERIOD', 'REVIEW_SCHEDULED', 'IMPORT', 'FALLBACK');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'FAILED', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'DEAD');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "currencyCode" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "displayName" TEXT NOT NULL DEFAULT 'Volume Pricing Manager',
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "settingsVersion" INTEGER NOT NULL DEFAULT 1,
    "spendPolicy" JSONB NOT NULL,
    "automationPolicy" JSONB NOT NULL,
    "pricingProvider" TEXT NOT NULL DEFAULT 'discount_function',
    "pricingStatus" "PricingSyncStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "pricingCompatibility" "PricingCompatibility" NOT NULL DEFAULT 'UNKNOWN',
    "pricingCompatibilityNote" TEXT,
    "discountCombination" TEXT NOT NULL DEFAULT 'stack_with_product_discounts',
    "notificationPrefs" JSONB NOT NULL DEFAULT '{}',
    "pricingExternalIds" JSONB NOT NULL DEFAULT '{}',
    "fallbackTierId" TEXT,
    "historyCoverageMonths" INTEGER,
    "historyAccessLimited" BOOLEAN NOT NULL DEFAULT false,
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastRecalculationAt" TIMESTAMP(3),
    "nextScheduledRunAt" TIMESTAMP(3),
    "importStatus" "ImportStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "importProgress" JSONB,
    "automationPaused" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingTier" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "badgeColor" TEXT NOT NULL DEFAULT '#5C6AC4',
    "minSpendMinor" BIGINT NOT NULL DEFAULT 0,
    "discountBps" INTEGER NOT NULL DEFAULT 0,
    "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
    "requiresLicense" BOOLEAN NOT NULL DEFAULT false,
    "requiresResaleCert" BOOLEAN NOT NULL DEFAULT false,
    "requiresPurchaseAgreement" BOOLEAN NOT NULL DEFAULT false,
    "minPurchaseHistoryMonths" INTEGER,
    "allowProjectedVolume" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "isFallback" BOOLEAN NOT NULL DEFAULT false,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingTier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerProfiles" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "email" TEXT,
    "displayName" TEXT,
    "qualifyingSpendMinor" BIGINT NOT NULL DEFAULT 0,
    "includedOrderCount" INTEGER NOT NULL DEFAULT 0,
    "refundDeductionMinor" BIGINT NOT NULL DEFAULT 0,
    "windowStart" TIMESTAMP(3),
    "windowEnd" TIMESTAMP(3),
    "spendComplete" BOOLEAN NOT NULL DEFAULT false,
    "historyStatus" "HistoryStatus" NOT NULL DEFAULT 'UNKNOWN',
    "calculatedTierId" TEXT,
    "effectiveTierId" TEXT,
    "pendingTierId" TEXT,
    "overrideTierId" TEXT,
    "businessApproved" BOOLEAN NOT NULL DEFAULT false,
    "licenseVerified" BOOLEAN NOT NULL DEFAULT false,
    "resaleCertVerified" BOOLEAN NOT NULL DEFAULT false,
    "purchaseAgreementVerified" BOOLEAN NOT NULL DEFAULT false,
    "projectedVolumeApproved" BOOLEAN NOT NULL DEFAULT false,
    "adminNotes" TEXT NOT NULL DEFAULT '',
    "firstOrderAt" TIMESTAMP(3),
    "overrideReason" TEXT,
    "overrideExpiresAt" TIMESTAMP(3),
    "overridePausesAutomation" BOOLEAN NOT NULL DEFAULT false,
    "overrideSetAt" TIMESTAMP(3),
    "overrideSetBy" TEXT,
    "gracePeriodEndsAt" TIMESTAMP(3),
    "nextReviewAt" TIMESTAMP(3),
    "lastCalculatedAt" TIMESTAMP(3),
    "lastAssignedAt" TIMESTAMP(3),
    "assignmentVersion" INTEGER NOT NULL DEFAULT 0,
    "pricingSyncStatus" "PricingSyncStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "pricingLastSyncedAt" TIMESTAMP(3),
    "pricingLastError" TEXT,
    "pricingExternalRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerProfiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NormalizedOrders" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerProfileId" TEXT,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyCustomerId" TEXT,
    "name" TEXT,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "financialStatus" TEXT NOT NULL,
    "fulfillmentStatus" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "test" BOOLEAN NOT NULL DEFAULT false,
    "currencyCode" TEXT NOT NULL,
    "merchandiseMinor" BIGINT NOT NULL DEFAULT 0,
    "discountMinor" BIGINT NOT NULL DEFAULT 0,
    "taxMinor" BIGINT NOT NULL DEFAULT 0,
    "shippingMinor" BIGINT NOT NULL DEFAULT 0,
    "refundedMerchandiseMinor" BIGINT NOT NULL DEFAULT 0,
    "qualifyingMinor" BIGINT NOT NULL DEFAULT 0,
    "salesChannel" TEXT,
    "sourceName" TEXT,
    "rawChecksum" TEXT,
    "lastSyncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NormalizedOrders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NormalizedOrderLines" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyLineId" TEXT NOT NULL,
    "productId" TEXT,
    "variantId" TEXT,
    "sku" TEXT,
    "title" TEXT,
    "quantity" INTEGER NOT NULL,
    "merchandiseMinor" BIGINT NOT NULL,
    "isGiftCard" BOOLEAN NOT NULL DEFAULT false,
    "excluded" BOOLEAN NOT NULL DEFAULT false,
    "collectionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],

    CONSTRAINT "NormalizedOrderLines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NormalizedRefunds" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyRefundId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "merchandiseMinor" BIGINT NOT NULL,
    "alreadyReflectedInOrder" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "NormalizedRefunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TierAssignmentHistory" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerProfileId" TEXT NOT NULL,
    "fromTierId" TEXT,
    "toTierId" TEXT,
    "calculatedTierId" TEXT,
    "effectiveTierId" TEXT,
    "changeType" "AssignmentChangeType" NOT NULL,
    "reason" TEXT NOT NULL,
    "actor" TEXT NOT NULL DEFAULT 'system',
    "spendSnapshotMinor" BIGINT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TierAssignmentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvents" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "shopifyWebhookId" TEXT,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BackgroundJobs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT,
    "shopDomain" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 5,
    "runAfter" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),
    "lockedBy" TEXT,
    "lastError" TEXT,
    "result" JSONB,
    "idempotencyKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "BackgroundJobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingSyncJobs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerProfileId" TEXT,
    "configVersion" INTEGER NOT NULL,
    "assignmentVersion" INTEGER NOT NULL,
    "desiredTierId" TEXT,
    "desiredDiscountBps" INTEGER,
    "status" "PricingSyncStatus" NOT NULL DEFAULT 'SYNCING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "providerResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "PricingSyncJobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigVersions" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConfigVersions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLogs" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLogs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_shopDomain_key" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "Shop_shopDomain_idx" ON "Shop"("shopDomain");

-- CreateIndex
CREATE INDEX "PricingTier_shopId_isActive_isArchived_idx" ON "PricingTier"("shopId", "isActive", "isArchived");

-- CreateIndex
CREATE INDEX "PricingTier_shopId_minSpendMinor_idx" ON "PricingTier"("shopId", "minSpendMinor");

-- CreateIndex
CREATE INDEX "PricingTier_shopId_displayOrder_idx" ON "PricingTier"("shopId", "displayOrder");

-- CreateIndex
CREATE UNIQUE INDEX "PricingTier_shopId_name_key" ON "PricingTier"("shopId", "name");

-- CreateIndex
CREATE INDEX "CustomerProfiles_shopId_effectiveTierId_idx" ON "CustomerProfiles"("shopId", "effectiveTierId");

-- CreateIndex
CREATE INDEX "CustomerProfiles_shopId_businessApproved_idx" ON "CustomerProfiles"("shopId", "businessApproved");

-- CreateIndex
CREATE INDEX "CustomerProfiles_shopId_pricingSyncStatus_idx" ON "CustomerProfiles"("shopId", "pricingSyncStatus");

-- CreateIndex
CREATE INDEX "CustomerProfiles_shopId_email_idx" ON "CustomerProfiles"("shopId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerProfiles_shopId_shopifyCustomerId_key" ON "CustomerProfiles"("shopId", "shopifyCustomerId");

-- CreateIndex
CREATE INDEX "NormalizedOrders_shopId_shopifyCustomerId_processedAt_idx" ON "NormalizedOrders"("shopId", "shopifyCustomerId", "processedAt");

-- CreateIndex
CREATE INDEX "NormalizedOrders_shopId_processedAt_idx" ON "NormalizedOrders"("shopId", "processedAt");

-- CreateIndex
CREATE INDEX "NormalizedOrders_customerProfileId_idx" ON "NormalizedOrders"("customerProfileId");

-- CreateIndex
CREATE UNIQUE INDEX "NormalizedOrders_shopId_shopifyOrderId_key" ON "NormalizedOrders"("shopId", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "NormalizedOrderLines_orderId_idx" ON "NormalizedOrderLines"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "NormalizedOrderLines_orderId_shopifyLineId_key" ON "NormalizedOrderLines"("orderId", "shopifyLineId");

-- CreateIndex
CREATE INDEX "NormalizedRefunds_orderId_idx" ON "NormalizedRefunds"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "NormalizedRefunds_orderId_shopifyRefundId_key" ON "NormalizedRefunds"("orderId", "shopifyRefundId");

-- CreateIndex
CREATE INDEX "TierAssignmentHistory_shopId_createdAt_idx" ON "TierAssignmentHistory"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "TierAssignmentHistory_customerProfileId_createdAt_idx" ON "TierAssignmentHistory"("customerProfileId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEvents_status_receivedAt_idx" ON "WebhookEvents"("status", "receivedAt");

-- CreateIndex
CREATE INDEX "WebhookEvents_shopDomain_topic_idx" ON "WebhookEvents"("shopDomain", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvents_shopDomain_topic_payloadHash_key" ON "WebhookEvents"("shopDomain", "topic", "payloadHash");

-- CreateIndex
CREATE INDEX "BackgroundJobs_status_runAfter_priority_idx" ON "BackgroundJobs"("status", "runAfter", "priority");

-- CreateIndex
CREATE INDEX "BackgroundJobs_shopDomain_type_idx" ON "BackgroundJobs"("shopDomain", "type");

-- CreateIndex
CREATE UNIQUE INDEX "BackgroundJobs_shopDomain_idempotencyKey_key" ON "BackgroundJobs"("shopDomain", "idempotencyKey");

-- CreateIndex
CREATE INDEX "PricingSyncJobs_shopId_status_idx" ON "PricingSyncJobs"("shopId", "status");

-- CreateIndex
CREATE INDEX "PricingSyncJobs_customerProfileId_status_idx" ON "PricingSyncJobs"("customerProfileId", "status");

-- CreateIndex
CREATE INDEX "ConfigVersions_shopId_kind_idx" ON "ConfigVersions"("shopId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigVersions_shopId_kind_version_key" ON "ConfigVersions"("shopId", "kind", "version");

-- CreateIndex
CREATE INDEX "AuditLogs_shopId_createdAt_idx" ON "AuditLogs"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLogs_shopId_action_idx" ON "AuditLogs"("shopId", "action");

-- CreateIndex
CREATE INDEX "AuditLogs_shopId_entityType_entityId_idx" ON "AuditLogs"("shopId", "entityType", "entityId");

-- AddForeignKey
ALTER TABLE "PricingTier" ADD CONSTRAINT "PricingTier_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProfiles" ADD CONSTRAINT "CustomerProfiles_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProfiles" ADD CONSTRAINT "CustomerProfiles_calculatedTierId_fkey" FOREIGN KEY ("calculatedTierId") REFERENCES "PricingTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProfiles" ADD CONSTRAINT "CustomerProfiles_effectiveTierId_fkey" FOREIGN KEY ("effectiveTierId") REFERENCES "PricingTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProfiles" ADD CONSTRAINT "CustomerProfiles_pendingTierId_fkey" FOREIGN KEY ("pendingTierId") REFERENCES "PricingTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerProfiles" ADD CONSTRAINT "CustomerProfiles_overrideTierId_fkey" FOREIGN KEY ("overrideTierId") REFERENCES "PricingTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedOrders" ADD CONSTRAINT "NormalizedOrders_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedOrders" ADD CONSTRAINT "NormalizedOrders_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedOrderLines" ADD CONSTRAINT "NormalizedOrderLines_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "NormalizedOrders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NormalizedRefunds" ADD CONSTRAINT "NormalizedRefunds_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "NormalizedOrders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TierAssignmentHistory" ADD CONSTRAINT "TierAssignmentHistory_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TierAssignmentHistory" ADD CONSTRAINT "TierAssignmentHistory_fromTierId_fkey" FOREIGN KEY ("fromTierId") REFERENCES "PricingTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TierAssignmentHistory" ADD CONSTRAINT "TierAssignmentHistory_toTierId_fkey" FOREIGN KEY ("toTierId") REFERENCES "PricingTier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEvents" ADD CONSTRAINT "WebhookEvents_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BackgroundJobs" ADD CONSTRAINT "BackgroundJobs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingSyncJobs" ADD CONSTRAINT "PricingSyncJobs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingSyncJobs" ADD CONSTRAINT "PricingSyncJobs_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigVersions" ADD CONSTRAINT "ConfigVersions_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLogs" ADD CONSTRAINT "AuditLogs_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

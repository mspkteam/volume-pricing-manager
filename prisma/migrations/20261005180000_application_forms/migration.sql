-- Forms builder, submissions, and private uploads

CREATE TYPE "FormLifecycleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
CREATE TYPE "FormPurpose" AS ENUM ('GENERAL', 'WHOLESALE');
CREATE TYPE "FormIdentityKind" AS ENUM ('GUEST', 'AUTHENTICATED', 'LINKED');
CREATE TYPE "FormApplicationStatus" AS ENUM ('PENDING', 'NEEDS_INFORMATION', 'APPROVED', 'REJECTED', 'WITHDRAWN');
CREATE TYPE "FormUploadScanStatus" AS ENUM ('PENDING', 'CLEAN', 'REJECTED', 'UNAVAILABLE');

CREATE TABLE "ApplicationForms" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" "FormLifecycleStatus" NOT NULL DEFAULT 'DRAFT',
    "purpose" "FormPurpose" NOT NULL DEFAULT 'GENERAL',
    "requireLogin" BOOLEAN NOT NULL DEFAULT true,
    "draftSchema" JSONB NOT NULL,
    "draftVersion" INTEGER NOT NULL DEFAULT 1,
    "publishedVersion" INTEGER,
    "publishedCacheKey" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedSchema" JSONB,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplicationForms_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FormVersions" (
    "id" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schema" JSONB NOT NULL,
    "cacheKey" TEXT NOT NULL,
    "publishedBy" TEXT NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormVersions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FormSubmissions" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "formVersionId" TEXT,
    "publishedVersion" INTEGER NOT NULL,
    "schemaCacheKey" TEXT NOT NULL,
    "shopifyCustomerId" TEXT,
    "customerProfileId" TEXT,
    "identityKind" "FormIdentityKind" NOT NULL DEFAULT 'GUEST',
    "applicantEmail" TEXT,
    "applicantName" TEXT,
    "companyName" TEXT,
    "answers" JSONB NOT NULL,
    "fieldSnapshots" JSONB NOT NULL,
    "requestedTierId" TEXT,
    "requestedTierSnapshot" JSONB,
    "mappedBusiness" JSONB,
    "consents" JSONB,
    "documentRefs" JSONB,
    "status" "FormApplicationStatus" NOT NULL DEFAULT 'PENDING',
    "customerMessage" TEXT,
    "internalNotes" TEXT NOT NULL DEFAULT '',
    "reviewHistory" JSONB NOT NULL DEFAULT '[]',
    "idempotencyKey" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedBy" TEXT,
    "revisionGroupId" TEXT,
    "revisionNumber" INTEGER NOT NULL DEFAULT 1,
    "supersededById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FormSubmissions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FormUploads" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "submissionId" TEXT,
    "fieldId" TEXT NOT NULL,
    "originalFilename" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "storageProvider" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "checksumSha256" TEXT,
    "scanStatus" "FormUploadScanStatus" NOT NULL DEFAULT 'PENDING',
    "quarantine" BOOLEAN NOT NULL DEFAULT false,
    "uploadedByCustomerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "FormUploads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ApplicationForms_shopId_handle_key" ON "ApplicationForms"("shopId", "handle");
CREATE INDEX "ApplicationForms_shopId_status_idx" ON "ApplicationForms"("shopId", "status");
CREATE INDEX "ApplicationForms_shopId_updatedAt_idx" ON "ApplicationForms"("shopId", "updatedAt");

CREATE UNIQUE INDEX "FormVersions_formId_version_key" ON "FormVersions"("formId", "version");
CREATE INDEX "FormVersions_formId_createdAt_idx" ON "FormVersions"("formId", "createdAt");

CREATE UNIQUE INDEX "FormSubmissions_shopId_idempotencyKey_key" ON "FormSubmissions"("shopId", "idempotencyKey");
CREATE INDEX "FormSubmissions_shopId_formId_status_submittedAt_idx" ON "FormSubmissions"("shopId", "formId", "status", "submittedAt");
CREATE INDEX "FormSubmissions_shopId_shopifyCustomerId_idx" ON "FormSubmissions"("shopId", "shopifyCustomerId");
CREATE INDEX "FormSubmissions_shopId_applicantEmail_idx" ON "FormSubmissions"("shopId", "applicantEmail");
CREATE INDEX "FormSubmissions_customerProfileId_idx" ON "FormSubmissions"("customerProfileId");

CREATE INDEX "FormUploads_shopId_submissionId_idx" ON "FormUploads"("shopId", "submissionId");
CREATE INDEX "FormUploads_shopId_storageKey_idx" ON "FormUploads"("shopId", "storageKey");

ALTER TABLE "ApplicationForms" ADD CONSTRAINT "ApplicationForms_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FormVersions" ADD CONSTRAINT "FormVersions_formId_fkey" FOREIGN KEY ("formId") REFERENCES "ApplicationForms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FormSubmissions" ADD CONSTRAINT "FormSubmissions_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FormSubmissions" ADD CONSTRAINT "FormSubmissions_formId_fkey" FOREIGN KEY ("formId") REFERENCES "ApplicationForms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FormSubmissions" ADD CONSTRAINT "FormSubmissions_formVersionId_fkey" FOREIGN KEY ("formVersionId") REFERENCES "FormVersions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FormSubmissions" ADD CONSTRAINT "FormSubmissions_customerProfileId_fkey" FOREIGN KEY ("customerProfileId") REFERENCES "CustomerProfiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "FormUploads" ADD CONSTRAINT "FormUploads_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "FormUploads" ADD CONSTRAINT "FormUploads_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "FormSubmissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

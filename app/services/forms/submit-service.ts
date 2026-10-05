import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { FormSchema } from "./field-registry";
import { validateSubmission } from "./validate-submission";
import { extractMappedBusiness } from "./review-service";
import { buildTierDisplayOptions } from "./validate-submission";
import { writeAuditLog } from "../audit/audit-log";
import { uploadsConfigured } from "../uploads/storage";

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export async function submitFormApplication(
  prisma: PrismaClient,
  args: {
    shopId: string;
    shopDomain: string;
    formHandle: string;
    answers: Record<string, unknown>;
    cacheKey: string;
    idempotencyKey: string;
    shopifyCustomerId: string | null;
    customerEmail?: string | null;
    customerDisplayName?: string | null;
  },
) {
  const form = await prisma.applicationForms.findFirst({
    where: { shopId: args.shopId, handle: args.formHandle, status: "PUBLISHED" },
  });
  if (!form || !form.publishedSchema || form.publishedVersion == null) {
    throw new Response(JSON.stringify({ error: "Form unavailable" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (form.requireLogin && !args.shopifyCustomerId) {
    throw new Response(JSON.stringify({ error: "Login required" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const existing = await prisma.formSubmissions.findFirst({
    where: { shopId: args.shopId, idempotencyKey: args.idempotencyKey },
  });
  if (existing) {
    return { duplicate: true as const, submissionId: existing.id, status: existing.status };
  }

  const schema = form.publishedSchema as unknown as FormSchema;
  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: args.shopId },
  });

  const validated = validateSubmission(schema, args.answers, {
    currencyCode: (await prisma.shop.findUniqueOrThrow({ where: { id: args.shopId } })).currencyCode,
    tiers,
    uploadsConfigured: true, // detailed check inside validators via upload field settings; re-check below
    schemaCacheKey: args.cacheKey,
    expectedCacheKey: form.publishedCacheKey || undefined,
  });

  // Re-validate with real upload configuration
  const validated2 = validateSubmission(schema, args.answers, {
    currencyCode: (await prisma.shop.findUniqueOrThrow({ where: { id: args.shopId } })).currencyCode,
    tiers,
    uploadsConfigured: uploadsConfigured(),
    schemaCacheKey: args.cacheKey,
    expectedCacheKey: form.publishedCacheKey || undefined,
  });
  void validated;

  if (!validated2.ok) {
    throw new Response(JSON.stringify({ error: "Validation failed", errors: validated2.errors }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const answers = validated2.answers;
  const fieldSnapshots: Record<string, { label: string; type: string }> = {};
  for (const f of schema.fields) {
    if (f.presentational) continue;
    fieldSnapshots[f.id] = { label: f.label, type: f.type };
  }

  let requestedTierId: string | null = null;
  let requestedTierSnapshot: object | null = null;
  const tierField = schema.fields.find((f) => f.type === "tier_select");
  if (tierField && answers[tierField.id]) {
    requestedTierId = String(answers[tierField.id]);
    const opts = buildTierDisplayOptions(
      tierField,
      tiers,
      (await prisma.shop.findUniqueOrThrow({ where: { id: args.shopId } })).currencyCode,
    );
    const snap = opts.find((o) => o.id === requestedTierId);
    const tier = tiers.find((t) => t.id === requestedTierId);
    requestedTierSnapshot = {
      id: requestedTierId,
      name: snap?.name ?? tier?.name,
      rangeLabel: snap?.rangeLabel,
      minSpendMinor: tier ? String(tier.minSpendMinor) : null,
      capturedAt: new Date().toISOString(),
    };
  }

  const mapped = extractMappedBusiness(schema, answers);
  const applicantEmail =
    (mapped.applicant_email as string) || args.customerEmail || null;
  const applicantName =
    (mapped.applicant_name as string) || args.customerDisplayName || null;
  const companyName = (mapped.company_name as string) || null;

  // Never attach guest to existing customer by email match alone
  let customerProfileId: string | null = null;
  let identityKind: "GUEST" | "AUTHENTICATED" | "LINKED" = "GUEST";
  if (args.shopifyCustomerId) {
    identityKind = "AUTHENTICATED";
    const profile = await prisma.customerProfiles.findFirst({
      where: { shopId: args.shopId, shopifyCustomerId: args.shopifyCustomerId },
    });
    customerProfileId = profile?.id ?? null;
  }

  const version = await prisma.formVersions.findFirst({
    where: { formId: form.id, version: form.publishedVersion },
  });

  const revisionGroupId = crypto.randomUUID();
  const submission = await prisma.formSubmissions.create({
    data: {
      shopId: args.shopId,
      formId: form.id,
      formVersionId: version?.id,
      publishedVersion: form.publishedVersion,
      schemaCacheKey: form.publishedCacheKey || args.cacheKey,
      shopifyCustomerId: args.shopifyCustomerId,
      customerProfileId,
      identityKind,
      applicantEmail,
      applicantName,
      companyName,
      answers: asJson(answers),
      fieldSnapshots: asJson(fieldSnapshots),
      requestedTierId,
      requestedTierSnapshot: requestedTierSnapshot
        ? asJson(requestedTierSnapshot)
        : undefined,
      mappedBusiness: asJson(mapped),
      consents:
        mapped.terms_consent != null
          ? asJson({
              terms: mapped.terms_consent,
              privacy: mapped.privacy_consent ?? null,
            })
          : undefined,
      documentRefs: asJson(
        Object.fromEntries(
          schema.fields
            .filter((f) => f.type === "file_upload" && answers[f.id])
            .map((f) => [f.id, answers[f.id]]),
        ),
      ),
      status: "PENDING",
      idempotencyKey: args.idempotencyKey,
      revisionGroupId,
      revisionNumber: 1,
    },
  });

  await writeAuditLog(prisma, {
    shopId: args.shopId,
    actor: args.shopifyCustomerId || "guest",
    action: "form.submitted",
    entityType: "FormSubmission",
    entityId: submission.id,
    summary: `Form ${form.handle} submitted`,
  });

  return { duplicate: false as const, submissionId: submission.id, status: submission.status };
}

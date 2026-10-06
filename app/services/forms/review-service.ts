import type { PrismaClient } from "@prisma/client";
import type { FormSchema } from "./field-registry";
import { writeAuditLog } from "../audit/audit-log";
import { recalculateCustomer } from "../assignment/recalculate";
import { enqueueJob, JOB_TYPES } from "../jobs/queue";

export type ReviewAction = "approve" | "reject" | "needs_information" | "withdraw";

function parseSchema(raw: unknown): FormSchema {
  return raw as FormSchema;
}

export function extractMappedBusiness(
  schema: FormSchema,
  answers: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const maps = schema.businessMappings || {};
  for (const [key, fieldId] of Object.entries(maps)) {
    if (!fieldId) continue;
    out[key] = answers[fieldId];
  }
  // Compose applicant name from first+last style adjacent short_text fields when mapped to first only
  const nameFieldId = maps.applicant_name;
  if (nameFieldId) {
    const idx = schema.fields.findIndex((f) => f.id === nameFieldId);
    const first = answers[nameFieldId];
    const next = schema.fields[idx + 1];
    if (next?.type === "short_text" && /last/i.test(next.label)) {
      out.applicant_name = [first, answers[next.id]].filter(Boolean).join(" ").trim();
    }
  }
  return out;
}

export async function reviewSubmission(
  prisma: PrismaClient,
  args: {
    shopId: string;
    shopDomain: string;
    submissionId: string;
    action: ReviewAction;
    actor: string;
    customerMessage?: string;
    internalNotes?: string;
    /** Explicit audited starting-tier override (projected volume) */
    startingTierId?: string | null;
    projectedVolumeOverride?: boolean;
    overrideReason?: string;
    overrideExpiresAt?: string | null;
    markLicenseVerified?: boolean;
    markResaleVerified?: boolean;
    markAgreementVerified?: boolean;
  },
) {
  const submission = await prisma.formSubmissions.findFirst({
    where: { id: args.submissionId, shopId: args.shopId },
    include: { form: true },
  });
  if (!submission) throw new Error("Submission not found");

  const history = Array.isArray(submission.reviewHistory)
    ? [...(submission.reviewHistory as object[])]
    : [];
  history.push({
    at: new Date().toISOString(),
    actor: args.actor,
    action: args.action,
    customerMessage: args.customerMessage || null,
    startingTierId: args.startingTierId || null,
  });

  if (args.action === "approve" && !submission.shopifyCustomerId) {
    throw new Error(
      "This applicant is not logged in to a Shopify customer account. Ask them to submit while logged in, or link a customer before approving.",
    );
  }

  let status = submission.status;
  if (args.action === "approve") status = "APPROVED";
  if (args.action === "reject") status = "REJECTED";
  if (args.action === "needs_information") status = "NEEDS_INFORMATION";
  if (args.action === "withdraw") status = "WITHDRAWN";

  const updated = await prisma.formSubmissions.update({
    where: { id: submission.id },
    data: {
      status,
      customerMessage: args.customerMessage ?? submission.customerMessage,
      internalNotes: args.internalNotes ?? submission.internalNotes,
      reviewHistory: history,
      reviewedAt: new Date(),
      reviewedBy: args.actor,
    },
  });

  await writeAuditLog(prisma, {
    shopId: args.shopId,
    actor: args.actor,
    action: `form.submission.${args.action}`,
    entityType: "FormSubmission",
    entityId: submission.id,
    summary: `Submission ${args.action}`,
    reason: args.overrideReason,
    metadata: { startingTierId: args.startingTierId },
  });

  if (args.action !== "approve") {
    return { submission: updated, pricingQueued: false };
  }

  // Approval updates eligibility — does NOT auto-grant requested tier.
  const shopifyCustomerId = submission.shopifyCustomerId;
  if (!shopifyCustomerId) {
    throw new Error(
      "This applicant is not logged in to a Shopify customer account. Ask them to submit while logged in, or link a customer before approving.",
    );
  }

  let profile = await prisma.customerProfiles.findFirst({
    where: { shopId: args.shopId, shopifyCustomerId },
  });
  if (!profile) {
    profile = await prisma.customerProfiles.create({
      data: {
        shopId: args.shopId,
        shopifyCustomerId,
        email: submission.applicantEmail,
        displayName: submission.applicantName,
      },
    });
  }

  const schema = parseSchema(submission.form.publishedSchema || submission.form.draftSchema);
  const mapped = (submission.mappedBusiness || {}) as Record<string, unknown>;

  await prisma.customerProfiles.update({
    where: { id: profile.id },
    data: {
      businessApproved: true,
      licenseVerified: args.markLicenseVerified ?? profile.licenseVerified,
      resaleCertVerified: args.markResaleVerified ?? profile.resaleCertVerified,
      purchaseAgreementVerified: args.markAgreementVerified ?? profile.purchaseAgreementVerified,
      projectedVolumeApproved: Boolean(args.projectedVolumeOverride),
      displayName: profile.displayName || submission.applicantName || profile.displayName,
      email: profile.email || submission.applicantEmail || profile.email,
      adminNotes: [profile.adminNotes, `Form approval ${submission.id}`, args.internalNotes]
        .filter(Boolean)
        .join("\n"),
      ...(args.projectedVolumeOverride && args.startingTierId
        ? {
            overrideTierId: args.startingTierId,
            overrideReason:
              args.overrideReason ||
              "Projected-volume starting tier from form approval (audited)",
            overrideExpiresAt: args.overrideExpiresAt
              ? new Date(args.overrideExpiresAt)
              : null,
            overrideSetAt: new Date(),
            overrideSetBy: args.actor,
            overridePausesAutomation: false,
            effectiveTierId: args.startingTierId,
          }
        : {}),
    },
  });

  await prisma.formSubmissions.update({
    where: { id: submission.id },
    data: {
      customerProfileId: profile.id,
      identityKind: "LINKED",
      mappedBusiness: { ...mapped, approvedAt: new Date().toISOString() },
    },
  });

  // Invoke existing tier engine from actual spend + verified eligibility
  const result = await recalculateCustomer(prisma, {
    shopId: args.shopId,
    shopDomain: args.shopDomain,
    customerProfileId: profile.id,
    actor: args.actor,
    enqueuePricingSync: true,
  });

  // If projected override was set, ensure pricing sync still queued
  if (args.projectedVolumeOverride && args.startingTierId) {
    const shop = await prisma.shop.findUniqueOrThrow({ where: { id: args.shopId } });
    const tier = await prisma.pricingTier.findFirst({
      where: { id: args.startingTierId, shopId: args.shopId },
    });
    await enqueueJob(prisma, {
      shopDomain: args.shopDomain,
      shopId: args.shopId,
      type: JOB_TYPES.SYNC_PRICING_CUSTOMER,
      payload: {
        customerProfileId: profile.id,
        tierId: args.startingTierId,
        discountBps: tier?.discountBps ?? 0,
        assignmentVersion: result.customer.assignmentVersion,
        configVersion: shop.settingsVersion,
      },
      idempotencyKey: `form-approve-sync:${submission.id}:${args.startingTierId}`,
    });
  }

  void schema;
  return { submission: updated, pricingQueued: true, customerProfileId: profile.id };
}

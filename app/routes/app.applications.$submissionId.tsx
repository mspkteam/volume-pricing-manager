import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { reviewSubmission } from "../services/forms/review-service";
import { syncCustomerWholesaleAccess } from "../services/wholesale/access-sync";
import type { FormSchema } from "../services/forms/field-registry";
import {
  ApplicationStatusBadge,
  EmbeddedSLink,
  FlashBanner,
  PageIntro,
} from "../components/admin/ui";
import { formatDateTime, formatFormAnswer } from "../lib/format";
import { pricingStatusLabel } from "../lib/pricing-status";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);

  const submission = await prisma.formSubmissions.findFirst({
    where: {
      id: String(params.submissionId),
      shopId: shop.id,
    },
    include: {
      form: true,
      customerProfile: {
        include: { effectiveTier: true },
      },
    },
  });
  if (!submission) throw new Response("Application not found", { status: 404 });

  const schema = (submission.form.publishedSchema ||
    submission.form.draftSchema) as unknown as FormSchema;
  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false },
    orderBy: { minSpendMinor: "asc" },
    select: { id: true, name: true, discountBps: true },
  });

  const answers = (submission.answers || {}) as Record<string, unknown>;
  const snapshots = (submission.fieldSnapshots || {}) as Record<
    string,
    { label: string; type: string }
  >;

  const customFields = (schema.fields || [])
    .filter((f) => !f.presentational)
    .map((f) => ({
      id: f.id,
      label: snapshots[f.id]?.label || f.label,
      type: snapshots[f.id]?.type || f.type,
      value: answers[f.id] ?? null,
    }));

  const uploadIds = customFields
    .filter((f) => f.type === "file_upload" && f.value != null && f.value !== "")
    .flatMap((f) => (Array.isArray(f.value) ? f.value : [f.value]))
    .map(String)
    .filter(Boolean);

  const uploads =
    uploadIds.length > 0
      ? await prisma.formUploads.findMany({
          where: { shopId: shop.id, id: { in: uploadIds } },
          select: { id: true, originalFilename: true },
        })
      : [];

  const tiersById: Record<string, { name: string; discountBps?: number }> = Object.fromEntries(
    tiers.map((t) => [t.id, { name: t.name, discountBps: t.discountBps }]),
  );
  const uploadsById: Record<string, { originalFilename: string }> = Object.fromEntries(
    uploads.map((u) => [u.id, { originalFilename: u.originalFilename }]),
  );

  const requested = submission.requestedTierSnapshot as {
    id?: string;
    name?: string;
    discountBps?: number;
  } | null;

  if (requested?.id && requested.name && !tiersById[requested.id]) {
    tiersById[requested.id] = {
      name: requested.name,
      discountBps: requested.discountBps,
    };
  }

  return {
    form: {
      id: submission.form.id,
      title: submission.form.title,
      handle: submission.form.handle,
    },
    submission: {
      id: submission.id,
      status: submission.status,
      identityKind: submission.identityKind,
      applicantName: submission.applicantName,
      applicantEmail: submission.applicantEmail,
      companyName: submission.companyName,
      shopifyCustomerId: submission.shopifyCustomerId,
      submittedAt: submission.submittedAt.toISOString(),
      reviewedAt: submission.reviewedAt?.toISOString() ?? null,
      reviewedBy: submission.reviewedBy,
      customerMessage: submission.customerMessage,
      internalNotes: submission.internalNotes,
      requestedTierId: submission.requestedTierId,
      requestedTierName: requested?.name ?? null,
      requestedTierSnapshot: submission.requestedTierSnapshot,
      mappedBusiness: submission.mappedBusiness,
      reviewHistory: submission.reviewHistory,
    },
    customFields,
    answerFormat: { tiersById, uploadsById },
    pricing: submission.customerProfile
      ? {
          profileId: submission.customerProfile.id,
          pricingSyncStatus: submission.customerProfile.pricingSyncStatus,
          pricingLastError: submission.customerProfile.pricingLastError,
          effectiveTier: submission.customerProfile.effectiveTier?.name ?? null,
          effectiveDiscountBps: submission.customerProfile.effectiveTier?.discountBps ?? 0,
          businessApproved: submission.customerProfile.businessApproved,
        }
      : null,
    tiers,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "") as
    | "approve"
    | "reject"
    | "needs_information"
    | "withdraw";

  try {
    const assignTier = formData.get("assignTierOnApprove") === "on";
    const result = await reviewSubmission(prisma, {
      shopId: shop.id,
      shopDomain: session.shop,
      submissionId: String(params.submissionId),
      action: intent,
      actor: session.shop,
      customerMessage: String(formData.get("customerMessage") || "") || undefined,
      internalNotes: String(formData.get("internalNotes") || "") || undefined,
      startingTierId: assignTier
        ? String(formData.get("startingTierId") || "") || null
        : null,
      projectedVolumeOverride: assignTier,
      overrideReason:
        String(formData.get("overrideReason") || "") ||
        (assignTier ? "Assigned from application review (role / requested tier)" : undefined),
      overrideExpiresAt: String(formData.get("overrideExpiresAt") || "") || null,
      markLicenseVerified: formData.get("markLicenseVerified") === "on",
      markResaleVerified: formData.get("markResaleVerified") === "on",
      markAgreementVerified: formData.get("markAgreementVerified") === "on",
      // Prefer form-requested tier when merchant left the select empty but checked assign
      preferRequestedTier: assignTier,
    });

    let tagMessage = "";
    if (intent === "approve" && result.customerProfileId) {
      const tags = await syncCustomerWholesaleAccess(prisma, admin, {
        shopId: shop.id,
        shopDomain: session.shop,
        customerProfileId: result.customerProfileId,
        actor: session.shop,
      });
      tagMessage = tags.ok
        ? ` Tags: ${tags.message}`
        : ` Tag sync warning: ${tags.message}`;
    }

    return {
      ok: true,
      message: `Application marked ${intent}.${tagMessage}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Review failed",
    };
  }
};

export default function ApplicationReviewPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const s = data.submission;
  const defaultTierId = s.requestedTierId || data.tiers[0]?.id || "";
  const storefrontActive = Boolean(data.pricing?.effectiveTier && data.pricing?.businessApproved);

  return (
    <s-page heading={s.applicantName || s.applicantEmail || "Application"}>
      <EmbeddedSLink slot="breadcrumb-actions" href="/app/applications">
        Applications
      </EmbeddedSLink>

      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Update this application’s status here. Approving a logged-in customer assigns their tier
        role tags (<code>vpm-approved</code>, tier name, <code>vpm-pct-N</code>) so storefront
        discounts can show.
      </PageIntro>

      <s-section heading="Status">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>
            Application: <ApplicationStatusBadge status={s.status} /> · Form: {data.form.title} ·
            Identity: {s.identityKind}
          </s-paragraph>
          <s-paragraph>
            Submitted {formatDateTime(s.submittedAt)}
            {s.reviewedAt
              ? ` · Reviewed ${formatDateTime(s.reviewedAt)} by ${s.reviewedBy}`
              : ""}
          </s-paragraph>
          {s.requestedTierName ? (
            <s-paragraph>
              Requested role / tier: <strong>{s.requestedTierName}</strong>
            </s-paragraph>
          ) : null}
          {data.pricing ? (
            <>
              <s-paragraph>
                Storefront pricing:{" "}
                <s-badge tone={storefrontActive ? "success" : undefined}>
                  {storefrontActive
                    ? "Active"
                    : data.pricing.effectiveTier
                      ? "Assigned"
                      : "Not assigned"}
                </s-badge>
                {data.pricing.effectiveTier
                  ? ` · Effective: ${data.pricing.effectiveTier} (${(
                      data.pricing.effectiveDiscountBps / 100
                    ).toFixed(0)}% off)`
                  : ""}
                {data.pricing.businessApproved ? " · Business approved" : ""}
              </s-paragraph>
              <s-paragraph>
                Checkout discount sync:{" "}
                <s-badge>{pricingStatusLabel(data.pricing.pricingSyncStatus)}</s-badge>
                {" · optional — tags power live storefront rates"}
                {data.pricing.pricingLastError ? (
                  <> · Error: {data.pricing.pricingLastError}</>
                ) : null}
              </s-paragraph>
            </>
          ) : (
            <s-paragraph>No linked customer profile yet (guest or unlinked).</s-paragraph>
          )}
        </div>
      </s-section>

      <s-section heading="Applicant">
        <s-unordered-list>
          <s-list-item>Name: {s.applicantName || "—"}</s-list-item>
          <s-list-item>Email: {s.applicantEmail || "—"}</s-list-item>
          <s-list-item>Company: {s.companyName || "—"}</s-list-item>
          <s-list-item>
            Shopify customer:{" "}
            {s.shopifyCustomerId && data.pricing?.profileId ? (
              <EmbeddedSLink href={`/app/customers/${data.pricing.profileId}`}>
                {s.shopifyCustomerId}
              </EmbeddedSLink>
            ) : (
              s.shopifyCustomerId || "—"
            )}
          </s-list-item>
        </s-unordered-list>
      </s-section>

      {!s.shopifyCustomerId ? (
        <s-banner tone="warning" heading="Guest application">
          This person was not logged in. Ask them to resubmit while signed in before you approve —
          Approve is blocked until a Shopify customer is linked (required for tags & discounts).
        </s-banner>
      ) : null}

      <s-section heading="Answers">
        {data.customFields.length === 0 ? (
          <s-paragraph>No answer fields on this submission.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Field</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Value</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.customFields.map((f) => (
                <s-table-row key={f.id}>
                  <s-table-cell>{f.label}</s-table-cell>
                  <s-table-cell>{f.type}</s-table-cell>
                  <s-table-cell>
                    <pre style={{ margin: 0, whiteSpace: "pre-wrap", font: "inherit" }}>
                      {formatFormAnswer(f.value, f.type, data.answerFormat)}
                    </pre>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Update status">
        <div className="vpm-panel">
          <Form method="post" className="vpm-form-stack">
            <s-text-field
              name="customerMessage"
              label="Customer-facing message"
              defaultValue={s.customerMessage || ""}
            />
            <label className="vpm-field">
              Internal notes
              <textarea name="internalNotes" rows={3} defaultValue={s.internalNotes || ""} />
            </label>

            <s-banner tone="info">
              On Approve, assign a tier so the customer gets role tags and storefront % discount
              (e.g. Wholesale → <code>vpm-pct-30</code>).
            </s-banner>

            <label className="vpm-check">
              <input
                type="checkbox"
                name="assignTierOnApprove"
                defaultChecked={Boolean(s.requestedTierId) || data.tiers.length > 0}
              />{" "}
              Assign tier / role tags on approve
            </label>
            <label className="vpm-field">
              Tier (role)
              <select name="startingTierId" defaultValue={defaultTierId}>
                <option value="">—</option>
                {data.tiers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name} ({(t.discountBps / 100).toFixed(0)}% off)
                  </option>
                ))}
              </select>
            </label>
            <s-text-field
              name="overrideReason"
              label="Reason (audit)"
              defaultValue={
                s.requestedTierName
                  ? `Requested role: ${s.requestedTierName}`
                  : "Assigned from application review"
              }
            />
            <label className="vpm-field">
              Override expiry (optional)
              <input type="datetime-local" name="overrideExpiresAt" />
            </label>

            <label className="vpm-check">
              <input type="checkbox" name="markLicenseVerified" /> Mark license verified
            </label>
            <label className="vpm-check">
              <input type="checkbox" name="markResaleVerified" /> Mark resale cert verified
            </label>
            <label className="vpm-check">
              <input type="checkbox" name="markAgreementVerified" /> Mark purchase agreement verified
            </label>

            <div className="vpm-actions">
              <button
                type="submit"
                name="intent"
                value="approve"
                className="vpm-btn"
                disabled={!s.shopifyCustomerId || s.status === "APPROVED"}
                title={
                  !s.shopifyCustomerId
                    ? "Applicant must be a logged-in Shopify customer"
                    : undefined
                }
              >
                Approve
              </button>
              <button
                type="submit"
                name="intent"
                value="needs_information"
                className="vpm-btn vpm-btn--secondary"
              >
                Needs information
              </button>
              <button
                type="submit"
                name="intent"
                value="reject"
                className="vpm-btn vpm-btn--critical"
              >
                Reject
              </button>
            </div>
          </Form>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);

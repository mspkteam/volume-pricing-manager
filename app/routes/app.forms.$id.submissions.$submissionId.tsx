import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { getForm } from "../services/forms/form-service";
import { reviewSubmission } from "../services/forms/review-service";
import type { FormSchema } from "../services/forms/field-registry";
import { ApplicationStatusBadge, FlashBanner, PageIntro } from "../components/admin/ui";
import { formatDateTime } from "../lib/format";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await getForm(prisma, shop.id, String(params.id));
  if (!form) throw new Response("Form not found", { status: 404 });

  const submission = await prisma.formSubmissions.findFirst({
    where: {
      id: String(params.submissionId),
      shopId: shop.id,
      formId: form.id,
    },
    include: {
      customerProfile: {
        include: { effectiveTier: true },
      },
    },
  });
  if (!submission) throw new Response("Submission not found", { status: 404 });

  const schema = (form.publishedSchema || form.draftSchema) as unknown as FormSchema;
  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false },
    orderBy: { minSpendMinor: "asc" },
    select: { id: true, name: true },
  });

  const answers = (submission.answers || {}) as Record<string, unknown>;
  const snapshots = (submission.fieldSnapshots || {}) as Record<
    string,
    { label: string; type: string }
  >;

  const customFields = schema.fields
    .filter((f) => !f.presentational)
    .map((f) => ({
      id: f.id,
      label: snapshots[f.id]?.label || f.label,
      type: snapshots[f.id]?.type || f.type,
      value: answers[f.id] ?? null,
    }));

  return {
    form: { id: form.id, title: form.title, handle: form.handle },
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
      requestedTierSnapshot: submission.requestedTierSnapshot,
      mappedBusiness: submission.mappedBusiness,
      reviewHistory: submission.reviewHistory,
    },
    customFields,
    pricing: submission.customerProfile
      ? {
          profileId: submission.customerProfile.id,
          pricingSyncStatus: submission.customerProfile.pricingSyncStatus,
          pricingLastError: submission.customerProfile.pricingLastError,
          effectiveTier: submission.customerProfile.effectiveTier?.name ?? null,
          businessApproved: submission.customerProfile.businessApproved,
          licenseVerified: submission.customerProfile.licenseVerified,
          resaleCertVerified: submission.customerProfile.resaleCertVerified,
          purchaseAgreementVerified: submission.customerProfile.purchaseAgreementVerified,
        }
      : null,
    tiers,
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "") as
    | "approve"
    | "reject"
    | "needs_information"
    | "withdraw";

  try {
    const projected = formData.get("projectedVolumeOverride") === "on";
    await reviewSubmission(prisma, {
      shopId: shop.id,
      shopDomain: session.shop,
      submissionId: String(params.submissionId),
      action: intent,
      actor: session.shop,
      customerMessage: String(formData.get("customerMessage") || "") || undefined,
      internalNotes: String(formData.get("internalNotes") || "") || undefined,
      startingTierId: projected
        ? String(formData.get("startingTierId") || "") || null
        : null,
      projectedVolumeOverride: projected,
      overrideReason: String(formData.get("overrideReason") || "") || undefined,
      overrideExpiresAt: String(formData.get("overrideExpiresAt") || "") || null,
      markLicenseVerified: formData.get("markLicenseVerified") === "on",
      markResaleVerified: formData.get("markResaleVerified") === "on",
      markAgreementVerified: formData.get("markAgreementVerified") === "on",
    });
    return { ok: true, message: `Submission marked ${intent}.` };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Review failed",
    };
  }
};

function formatAnswer(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return JSON.stringify(value, null, 2);
  return String(value);
}

export default function SubmissionDetailPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const s = data.submission;

  return (
    <s-page heading={s.applicantName || s.applicantEmail || "Submission"}>
      <s-link slot="breadcrumb-actions" href={`/app/forms/${data.form.id}/submissions`}>
        Submissions
      </s-link>

      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Application status is independent of pricing sync. Approving eligibility does not
        automatically grant the requested tier unless you set an audited starting-tier override.
      </PageIntro>

      <s-section heading="Status">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>
            Application: <ApplicationStatusBadge status={s.status} /> · Identity: {s.identityKind}
          </s-paragraph>
          <s-paragraph>
            Submitted {formatDateTime(s.submittedAt)}
            {s.reviewedAt
              ? ` · Reviewed ${formatDateTime(s.reviewedAt)} by ${s.reviewedBy}`
              : ""}
          </s-paragraph>
          {data.pricing ? (
            <s-paragraph>
              Pricing sync: <s-badge>{data.pricing.pricingSyncStatus}</s-badge>
              {data.pricing.effectiveTier
                ? ` · Effective tier: ${data.pricing.effectiveTier}`
                : ""}
              {data.pricing.pricingLastError ? (
                <> · Error: {data.pricing.pricingLastError}</>
              ) : null}
            </s-paragraph>
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
          <s-list-item>Shopify customer: {s.shopifyCustomerId || "—"}</s-list-item>
        </s-unordered-list>
      </s-section>

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
                      {formatAnswer(f.value)}
                    </pre>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section heading="Review">
        <div className="vpm-panel">
          <Form method="post" className="vpm-form-stack">
            <s-text-field
              name="customerMessage"
              label="Customer-facing message"
              value={s.customerMessage || ""}
            />
            <label className="vpm-field">
              Internal notes
              <textarea name="internalNotes" rows={3} defaultValue={s.internalNotes || ""} />
            </label>

            <s-banner tone="info">
              On approve you may set an audited projected-volume starting tier. This is separate from
              spend-based qualification.
            </s-banner>

            <label className="vpm-check">
              <input type="checkbox" name="projectedVolumeOverride" /> Starting tier override
              (projected volume)
            </label>
            <label className="vpm-field">
              Starting tier
              <select name="startingTierId" defaultValue="">
                <option value="">—</option>
                {data.tiers.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <s-text-field name="overrideReason" label="Override reason" />
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
              <button type="submit" name="intent" value="approve" className="vpm-btn">
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

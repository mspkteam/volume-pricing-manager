import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import {
  EmbeddedSLink,
  Field,
  FlashBanner,
  PageIntro,
  SubmitButton,
  TextArea,
  WarrantyStatusBadge,
} from "../components/admin/ui";
import { formatDateTime, formatMoneyMinor } from "../lib/format";
import { ensureWarrantySettings, toWarrantySettingsView } from "../services/warranty/settings";
import { reviewWarrantyClaim, type ReviewWarrantyAction } from "../services/warranty/review";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const settings = await ensureWarrantySettings(prisma, shop.id);
  const claim = await prisma.warrantyClaims.findFirst({
    where: { id: String(params.id), shopId: shop.id },
  });
  if (!claim) throw new Response("Not found", { status: 404 });

  return {
    currencyCode: shop.currencyCode,
    settings: toWarrantySettingsView(settings),
    claim: {
      ...claim,
      shippingAmountMinor:
        claim.shippingAmountMinor != null ? Number(claim.shippingAmountMinor) : null,
      purchaseDate: claim.purchaseDate?.toISOString() ?? null,
      submittedAt: claim.submittedAt.toISOString(),
      reviewedAt: claim.reviewedAt?.toISOString() ?? null,
      reviewHistory: claim.reviewHistory,
      attachmentUrls: claim.attachmentUrls,
    },
  };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "") as ReviewWarrantyAction;
  const allowed: ReviewWarrantyAction[] = [
    "approve",
    "reject",
    "needs_information",
    "close",
    "send_shipping_invoice",
  ];
  if (!allowed.includes(intent)) {
    return { ok: false, message: "Unknown action" };
  }

  try {
    const amountRaw = String(formData.get("shippingAmount") || "").trim();
    const shippingAmountMinorOverride =
      amountRaw !== "" ? Math.round(Number(amountRaw) * 100) : null;

    const result = await reviewWarrantyClaim(prisma, {
      shopId: shop.id,
      shopDomain: session.shop,
      claimId: String(params.id),
      action: intent,
      actor: session.shop,
      customerMessage: String(formData.get("customerMessage") || "") || undefined,
      internalNotes: String(formData.get("internalNotes") || "") || undefined,
      admin,
      shippingAmountMinorOverride,
    });

    const invoiceNote = result.invoiceWarning
      ? ` Invoice warning: ${result.invoiceWarning}`
      : result.claim.shippingInvoiceUrl
        ? ` Invoice: ${result.claim.shippingInvoiceUrl}`
        : "";

    return {
      ok: true,
      message: `Claim marked ${result.claim.status}.${invoiceNote}`,
    };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Review failed",
    };
  }
};

export default function WarrantyClaimDetail() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const c = data.claim;

  return (
    <s-page heading={c.claimNumber}>
      <EmbeddedSLink slot="breadcrumb-actions" href="/app/warranty">
        Warranty claims
      </EmbeddedSLink>

      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Review the claim, then approve and send a shipping &amp; handling invoice when a
        replacement should ship.
      </PageIntro>

      <s-section heading="Status">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>
            <WarrantyStatusBadge status={c.status} />
            {c.withinWarrantyWindow == null
              ? " · Warranty window unknown"
              : c.withinWarrantyWindow
                ? " · In warranty window"
                : " · Outside warranty window"}
          </s-paragraph>
          <s-paragraph>
            Submitted {formatDateTime(c.submittedAt)}
            {c.reviewedAt ? ` · Reviewed ${formatDateTime(c.reviewedAt)} by ${c.reviewedBy}` : ""}
          </s-paragraph>
          {c.shippingInvoiceUrl ? (
            <s-paragraph>
              Shipping invoice:{" "}
              <a href={c.shippingInvoiceUrl} target="_blank" rel="noreferrer">
                Open invoice
              </a>
              {c.shippingAmountMinor != null
                ? ` (${formatMoneyMinor(c.shippingAmountMinor, data.currencyCode)})`
                : ""}
            </s-paragraph>
          ) : null}
        </div>
      </s-section>

      <s-section heading="Claim details">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>
            <strong>Customer:</strong> {c.customerName || "—"} · {c.customerEmail}
            {c.customerPhone ? ` · ${c.customerPhone}` : ""}
          </s-paragraph>
          <s-paragraph>
            <strong>Company:</strong> {c.companyName || "—"}
          </s-paragraph>
          <s-paragraph>
            <strong>Product:</strong> {c.productSku}
            {c.productTitle ? ` — ${c.productTitle}` : ""}
          </s-paragraph>
          <s-paragraph>
            <strong>Order:</strong> {c.orderNumber || "—"} · <strong>Purchase date:</strong>{" "}
            {c.purchaseDate ? formatDateTime(c.purchaseDate) : "—"}
          </s-paragraph>
          <s-paragraph>
            <strong>Issue:</strong>
            <br />
            {c.issueDescription}
          </s-paragraph>
        </div>
      </s-section>

      <s-section heading="Review actions">
        <Form method="post" className="vpm-panel vpm-stack">
          <TextArea
            label="Message to customer (optional)"
            name="customerMessage"
            defaultValue={c.customerMessage || ""}
          />
          <TextArea
            label="Internal notes"
            name="internalNotes"
            defaultValue={c.internalNotes || ""}
          />
          <Field
            label={`Shipping & handling amount (${data.currencyCode})`}
            name="shippingAmount"
            defaultValue={(data.settings.shippingHandlingMinor / 100).toFixed(2)}
          />
          <div className="vpm-actions">
            <SubmitButton name="intent" value="approve">
              Approve
            </SubmitButton>
            <SubmitButton name="intent" value="send_shipping_invoice" variant="secondary">
              Create S&amp;H invoice
            </SubmitButton>
            <SubmitButton name="intent" value="needs_information" variant="secondary">
              Needs information
            </SubmitButton>
            <SubmitButton name="intent" value="reject" variant="critical">
              Reject
            </SubmitButton>
            <SubmitButton name="intent" value="close" variant="secondary">
              Close
            </SubmitButton>
          </div>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

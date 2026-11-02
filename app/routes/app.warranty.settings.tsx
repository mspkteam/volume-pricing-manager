import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import {
  Check,
  EmbeddedSLink,
  Field,
  FlashBanner,
  PageIntro,
  SubmitButton,
  TextArea,
} from "../components/admin/ui";
import {
  ensureWarrantySettings,
  toWarrantySettingsView,
  updateWarrantySettings,
} from "../services/warranty/settings";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const settings = await ensureWarrantySettings(prisma, shop.id);
  return {
    currencyCode: shop.currencyCode,
    settings: toWarrantySettingsView(settings),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const formData = await request.formData();

  try {
    const amount = Number(String(formData.get("shippingHandlingAmount") || "0"));
    await updateWarrantySettings(prisma, shop.id, {
      warrantyWindowDays: Number(formData.get("warrantyWindowDays") || 365),
      shippingHandlingMinor: Math.round(amount * 100),
      shippingHandlingTitle: String(formData.get("shippingHandlingTitle") || ""),
      requireLogin: formData.get("requireLogin") === "on",
      requireOrderNumber: formData.get("requireOrderNumber") === "on",
      requirePurchaseDate: formData.get("requirePurchaseDate") === "on",
      successMessage: String(formData.get("successMessage") || ""),
      introHtml: String(formData.get("introHtml") || ""),
    });
    return { ok: true, message: "Warranty settings saved." };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : "Save failed",
    };
  }
};

export default function WarrantySettingsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const s = data.settings;

  return (
    <s-page heading="Warranty settings">
      <EmbeddedSLink slot="breadcrumb-actions" href="/app/warranty">
        Warranty claims
      </EmbeddedSLink>

      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Configure the warranty window and the default shipping &amp; handling amount used when
        approving claims.
      </PageIntro>

      <s-section heading="Policy">
        <Form method="post" className="vpm-panel vpm-stack">
          <Field
            label="Warranty window (days from purchase)"
            name="warrantyWindowDays"
            defaultValue={String(s.warrantyWindowDays)}
          />
          <p className="vpm-muted">
            Use 0 to treat every claim as in-window. Outside-window claims are still accepted but
            flagged for review.
          </p>
          <Field
            label={`Default shipping & handling (${data.currencyCode})`}
            name="shippingHandlingAmount"
            defaultValue={(s.shippingHandlingMinor / 100).toFixed(2)}
          />
          <Field
            label="Invoice line item title"
            name="shippingHandlingTitle"
            defaultValue={s.shippingHandlingTitle}
          />
          <Check label="Require customer login" name="requireLogin" defaultChecked={s.requireLogin} />
          <Check
            label="Require order number"
            name="requireOrderNumber"
            defaultChecked={s.requireOrderNumber}
          />
          <Check
            label="Require purchase date"
            name="requirePurchaseDate"
            defaultChecked={s.requirePurchaseDate}
          />
          <TextArea
            label="Storefront success message"
            name="successMessage"
            defaultValue={s.successMessage}
          />
          <TextArea
            label="Optional intro HTML on the form"
            name="introHtml"
            defaultValue={s.introHtml}
          />
          <SubmitButton>Save settings</SubmitButton>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

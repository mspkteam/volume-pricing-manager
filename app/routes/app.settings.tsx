import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop, parseSpendPolicy } from "../services/shop/shop-service";
import { getPricingProvider } from "../services/pricing/discount-function-provider";
import { writeAuditLog } from "../services/audit/audit-log";
import type { SpendPolicy } from "../lib/policies";
import { FlashBanner, PageIntro, PricingStatusBadge } from "../components/admin/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const distribution =
    (process.env.SHOPIFY_APP_DISTRIBUTION as "app_store" | "custom" | "unknown") || "unknown";
  const provider = getPricingProvider(shop.pricingProvider, null, false);
  const compatibility = await provider.verifyCompatibility({
    shopDomain: session.shop,
    distribution,
    planName: null,
    functionsAvailable: null,
  });

  return {
    shop: {
      displayName: shop.displayName,
      currencyCode: shop.currencyCode,
      timezone: shop.timezone,
      pricingProvider: shop.pricingProvider,
      pricingStatus: shop.pricingStatus,
      pricingCompatibility: shop.pricingCompatibility,
      pricingCompatibilityNote: shop.pricingCompatibilityNote,
      discountCombination: shop.discountCombination,
      notificationPrefs: shop.notificationPrefs,
    },
    spendPolicy: parseSpendPolicy(shop.spendPolicy),
    providerCapability: provider.capability,
    liveCompatibility: compatibility,
    writesEnabled: process.env.PRICING_WRITES_ENABLED === "true",
    distribution,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "save") {
      const spendPolicy: SpendPolicy = {
        ...parseSpendPolicy(shop.spendPolicy),
        excludedProductIds: String(form.get("excludedProductIds") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        excludedCollectionIds: String(form.get("excludedCollectionIds") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        includedSalesChannels: String(form.get("includedSalesChannels") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      };

      const distribution =
        (process.env.SHOPIFY_APP_DISTRIBUTION as "app_store" | "custom" | "unknown") || "unknown";
      const provider = getPricingProvider("discount_function", null, false);
      const compatibility = await provider.verifyCompatibility({
        shopDomain: session.shop,
        distribution,
        functionsAvailable: null,
      });

      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          displayName: String(form.get("displayName") || "Volume Pricing Manager"),
          discountCombination: String(form.get("discountCombination") || shop.discountCombination),
          spendPolicy,
          pricingProvider: "discount_function",
          pricingStatus: compatibility.status,
          pricingCompatibility: compatibility.compatibility,
          pricingCompatibilityNote: compatibility.message,
          notificationPrefs: {
            emailEnabled: form.get("emailEnabled") === "on",
            smsEnabled: false,
          },
          settingsVersion: { increment: 1 },
        },
      });

      await writeAuditLog(prisma, {
        shopId: shop.id,
        actor: session.shop,
        action: "settings.update",
        entityType: "Shop",
        entityId: shop.id,
        summary: "Updated app settings",
      });
      return { ok: true, message: "Settings saved." };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Failed" };
  }
  return { ok: false, message: "Unknown action" };
};

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const prefs = (data.shop.notificationPrefs || {}) as { emailEnabled?: boolean };

  return (
    <s-page heading="Settings">
      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Shop currency and timezone come from Shopify. Configure spend exclusions, discount behavior,
        and pricing provider compatibility here. Spend policies and the job worker live under{" "}
        <s-link href="/app/automation">Automation</s-link>.
      </PageIntro>

      <s-section heading="Shop display">
        <s-paragraph>
          Currency: {data.shop.currencyCode} · Timezone: {data.shop.timezone} (from Shopify; shown
          here for reference)
        </s-paragraph>
      </s-section>

      <s-section heading="Pricing provider">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>
            Provider: <s-text type="strong">{data.providerCapability.displayName}</s-text>
          </s-paragraph>
          <PricingStatusBadge
            status={data.shop.pricingStatus}
            compatibility={data.shop.pricingCompatibility}
          />
          <s-paragraph>{data.liveCompatibility.message}</s-paragraph>
          <s-paragraph>
            Distribution: {data.distribution} · Pricing writes:{" "}
            {data.writesEnabled ? "enabled" : "disabled (safe default)"}
          </s-paragraph>
          <ul className="vpm-checklist">
            {data.providerCapability.setupSteps.map((step) => (
              <li key={step} className="vpm-checklist-item">
                <span className="vpm-checklist-icon vpm-checklist-icon--pending" aria-hidden />
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </div>
        <s-banner tone="info">
          Custom-distributed apps need Shopify Plus for Functions. App Store apps can use Functions
          on all plans.
        </s-banner>
      </s-section>

      <s-section heading="App settings">
        <div className="vpm-panel">
        <Form method="post" className="vpm-form-stack">
          <input type="hidden" name="intent" value="save" />
          <s-stack direction="block" gap="base">
            <s-text-field name="displayName" label="App display name" defaultValue={data.shop.displayName} />
            <label className="vpm-field">
              Discount combination
              <select name="discountCombination" defaultValue={data.shop.discountCombination}>
                <option value="stack_with_product_discounts">Stack with product discounts</option>
                <option value="exclusive">Exclusive (avoid double discounting where possible)</option>
              </select>
            </label>
            <s-text-field
              name="excludedProductIds"
              label="Excluded product GIDs (comma-separated)"
              defaultValue={data.spendPolicy.excludedProductIds.join(",")}
            />
            <s-text-field
              name="excludedCollectionIds"
              label="Excluded collection GIDs (comma-separated)"
              defaultValue={data.spendPolicy.excludedCollectionIds.join(",")}
            />
            <s-text-field
              name="includedSalesChannels"
              label="Included sales channels (empty = all)"
              defaultValue={data.spendPolicy.includedSalesChannels.join(",")}
            />
            <label>
              <input type="checkbox" name="emailEnabled" defaultChecked={Boolean(prefs.emailEnabled)} />{" "}
              Email notification preference (no messaging integration auto-enabled)
            </label>
            <s-button type="submit">Save settings</s-button>
          </s-stack>
        </Form>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);

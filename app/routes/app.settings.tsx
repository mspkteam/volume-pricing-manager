import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop, parseSpendPolicy } from "../services/shop/shop-service";
import { shopCheckoutWritesEnabled } from "../services/pricing/probe-compatibility";
import { syncTierToAutomaticDiscounts } from "../services/pricing/automatic-basic-sync";
import { writeAuditLog } from "../services/audit/audit-log";
import type { SpendPolicy } from "../lib/policies";
import {
  AdminLink,
  Field,
  FlashBanner,
  PageIntro,
  PricingStatusBadge,
  SubmitButton,
} from "../components/admin/ui";
import { ResourcePickerField } from "../components/admin/resource-picker-field";

async function resolveResourceTitles(
  admin: { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> },
  ids: string[],
): Promise<Array<{ id: string; title: string }>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (!unique.length) return [];
  try {
    const res = await admin.graphql(
      `#graphql
      query Nodes($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Product { id title }
          ... on Collection { id title }
        }
      }`,
      { variables: { ids: unique } },
    );
    const json = await res.json();
    const nodes = (json.data?.nodes || []) as Array<{ id?: string; title?: string } | null>;
    const byId = new Map<string, string>();
    for (const n of nodes) {
      if (n?.id) byId.set(n.id, n.title || n.id);
    }
    return unique.map((id) => ({ id, title: byId.get(id) || id }));
  } catch {
    return unique.map((id) => ({ id, title: id }));
  }
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const external = (shop.pricingExternalIds as Record<string, unknown>) || {};
  const writesEnabled = shopCheckoutWritesEnabled(shop.pricingExternalIds);
  const checkoutMode =
    (external.checkoutMode as string) ||
    (shop.pricingProvider === "automatic_basic" ? "automatic_basic" : "discount_function");
  const automaticDiscounts = (external.automaticDiscounts || {}) as Record<
    string,
    { percent?: number; title?: string; discountGid?: string }
  >;
  const autoCount = Object.values(automaticDiscounts).filter((d) => d?.discountGid).length;

  const spendPolicy = parseSpendPolicy(shop.spendPolicy);
  const [excludedProducts, excludedCollections] = await Promise.all([
    resolveResourceTitles(admin, spendPolicy.excludedProductIds),
    resolveResourceTitles(admin, spendPolicy.excludedCollectionIds),
  ]);

  const checkoutActive = writesEnabled && (shop.pricingStatus === "SYNCED" || autoCount > 0);

  return {
    shop: {
      displayName: shop.displayName,
      currencyCode: shop.currencyCode,
      timezone: shop.timezone,
      pricingStatus: shop.pricingStatus,
      pricingCompatibility: shop.pricingCompatibility,
      pricingCompatibilityNote: shop.pricingCompatibilityNote,
      discountCombination: shop.discountCombination,
      pricingProvider: shop.pricingProvider,
    },
    spendPolicy,
    excludedProducts,
    excludedCollections,
    writesEnabled,
    checkoutActive,
    checkoutMode,
    automaticDiscountCount: autoCount,
    automaticDiscountSummaries: Object.values(automaticDiscounts)
      .filter((d) => d?.discountGid)
      .map((d) => d.title || `${d.percent}%`),
    storefrontPricing: {
      status: "ACTIVE",
      message:
        "Customer tags (vpm-approved, vpm-pct-*, Wholesale / Distributor / Retailer) drive prices on the theme.",
    },
    // Stubs so a cached older Settings client bundle does not crash on data.probe.planName
    providerLabel: checkoutMode === "automatic_basic" ? "Automatic tier discounts" : "Shopify Discount Function",
    liveCompatibility: {
      message:
        shop.pricingCompatibilityNote ||
        "Use Create checkout discounts from tiers to sync automatic % off at checkout.",
    },
    probe: {
      planName: null as string | null,
      distribution: "custom" as const,
      functionsAvailable: false,
      functionTitle: null as string | null,
      functionId: null as string | null,
      discountGid: null as string | null,
      isPlusEligible: false,
      error: null as string | null,
    },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  try {
    if (intent === "save") {
      const existing = parseSpendPolicy(shop.spendPolicy);
      const spendPolicy: SpendPolicy = {
        ...existing,
        excludedProductIds: String(form.get("excludedProductIds") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        excludedCollectionIds: String(form.get("excludedCollectionIds") || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        includedSalesChannels: existing.includedSalesChannels,
      };

      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          displayName: String(form.get("displayName") || "Volume Pricing Manager"),
          discountCombination: String(form.get("discountCombination") || shop.discountCombination),
          spendPolicy,
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

    if (intent === "activate_checkout") {
      // Primary path: native automatic % discounts per tier (vpm-pct-* tags) — no Function/Plus required.
      const sync = await syncTierToAutomaticDiscounts(prisma, admin, {
        shopId: shop.id,
        shopDomain: session.shop,
        actor: session.shop,
      });
      return {
        ok: sync.ok,
        message: sync.message,
      };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Failed" };
  }
  return { ok: false, message: "Unknown action" };
};

export default function SettingsPage() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const checkoutActive = data.checkoutActive;

  return (
    <s-page heading="Settings">
      {actionData?.message ? (
        <FlashBanner message={actionData.message} ok={actionData.ok} />
      ) : null}

      <PageIntro>
        Currency {data.shop.currencyCode} · {data.shop.timezone}. Spend / automation rules:{" "}
        <AdminLink to="/app/automation">Automation</AdminLink>.
      </PageIntro>

      <s-section heading="Basics">
        <div className="vpm-panel">
          <Form method="post" className="vpm-form-stack">
            <input type="hidden" name="intent" value="save" />
            <Field
              label="App display name"
              name="displayName"
              defaultValue={data.shop.displayName}
            />
            <label className="vpm-field">
              How volume discounts combine with other product discounts
              <select name="discountCombination" defaultValue={data.shop.discountCombination}>
                <option value="stack_with_product_discounts">Stack with product discounts</option>
                <option value="exclusive">Exclusive (prefer not to double-discount)</option>
              </select>
            </label>

            <ResourcePickerField
              type="product"
              name="excludedProductIds"
              label="Excluded products"
              helpText="These products do not count toward qualifying spend."
              initialItems={data.excludedProducts}
            />
            <ResourcePickerField
              type="collection"
              name="excludedCollectionIds"
              label="Excluded collections"
              helpText="Products in these collections do not count toward qualifying spend."
              initialItems={data.excludedCollections}
            />

            <SubmitButton>Save settings</SubmitButton>
          </Form>
        </div>
      </s-section>

      <s-section heading="Storefront pricing (tags)">
        <div className="vpm-panel vpm-stack-tight">
          <s-banner tone="success" heading="Active">
            {data.storefrontPricing.message}
          </s-banner>
          <s-paragraph>
            Approving an application writes tags like <s-text type="strong">vpm-approved</s-text> and{" "}
            <s-text type="strong">vpm-pct-30</s-text>. MFG theme sections read those tags and show the
            discounted price.
          </s-paragraph>
        </div>
      </s-section>

      <s-section heading="Checkout discounts (from tiers)">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>
            Creates Shopify <s-text type="strong">automatic % discounts</s-text> (no coupon codes)
            linked to each tier rate. Buyers with tag <s-text type="strong">vpm-pct-30</s-text> get
            30% off at checkout automatically — same rate as the storefront.
          </s-paragraph>

          {checkoutActive ? (
            <s-banner tone="success" heading="Checkout discounts active">
              {data.automaticDiscountCount} automatic discount
              {data.automaticDiscountCount === 1 ? "" : "s"} synced
              {data.automaticDiscountSummaries.length
                ? `: ${data.automaticDiscountSummaries.join(", ")}`
                : ""}
              .
            </s-banner>
          ) : (
            <PricingStatusBadge
              status={data.shop.pricingStatus}
              compatibility={data.shop.pricingCompatibility}
            />
          )}

          {data.shop.pricingCompatibilityNote ? (
            <s-paragraph>{data.shop.pricingCompatibilityNote}</s-paragraph>
          ) : null}

          <Form method="post">
            <input type="hidden" name="intent" value="activate_checkout" />
            <SubmitButton>
              {checkoutActive
                ? "Re-sync tier discounts to checkout"
                : "Create checkout discounts from tiers"}
            </SubmitButton>
          </Form>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);

import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop, parseSpendPolicy } from "../services/shop/shop-service";
import { getPricingProvider } from "../services/pricing/discount-function-provider";
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
  const distribution =
    (process.env.SHOPIFY_APP_DISTRIBUTION as "app_store" | "custom" | "unknown") || "unknown";
  const provider = getPricingProvider(shop.pricingProvider, null, false);
  const compatibility = await provider.verifyCompatibility({
    shopDomain: session.shop,
    distribution,
    planName: null,
    functionsAvailable: null,
  });

  const spendPolicy = parseSpendPolicy(shop.spendPolicy);
  const [excludedProducts, excludedCollections] = await Promise.all([
    resolveResourceTitles(admin, spendPolicy.excludedProductIds),
    resolveResourceTitles(admin, spendPolicy.excludedCollectionIds),
  ]);

  return {
    shop: {
      displayName: shop.displayName,
      currencyCode: shop.currencyCode,
      timezone: shop.timezone,
      pricingStatus: shop.pricingStatus,
      pricingCompatibility: shop.pricingCompatibility,
      discountCombination: shop.discountCombination,
    },
    spendPolicy,
    excludedProducts,
    excludedCollections,
    providerLabel: provider.capability.displayName,
    liveCompatibility: compatibility,
    writesEnabled: process.env.PRICING_WRITES_ENABLED === "true",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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
        // Keep previous channel filter unless we expose UI again
        includedSalesChannels: existing.includedSalesChannels,
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

      <s-section heading="Checkout pricing status">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>
            Provider: <s-text type="strong">{data.providerLabel}</s-text>
          </s-paragraph>
          <PricingStatusBadge
            status={data.shop.pricingStatus}
            compatibility={data.shop.pricingCompatibility}
          />
          <s-paragraph>{data.liveCompatibility.message}</s-paragraph>
          <s-paragraph>
            Pricing writes are {data.writesEnabled ? "enabled" : "disabled (safe default)"}. Storefront
            tag pricing can still work without checkout Function writes.
          </s-paragraph>
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);

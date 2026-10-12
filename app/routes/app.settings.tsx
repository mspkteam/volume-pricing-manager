import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop, parseSpendPolicy } from "../services/shop/shop-service";
import { getPricingProvider } from "../services/pricing/discount-function-provider";
import {
  createVolumeAutomaticDiscount,
  probePricingCompatibility,
  resolveAppDistribution,
  shopCheckoutWritesEnabled,
} from "../services/pricing/probe-compatibility";
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
  const distribution = resolveAppDistribution();
  const probe = await probePricingCompatibility(admin, distribution);
  const writesEnabled = shopCheckoutWritesEnabled(shop.pricingExternalIds);
  const provider = getPricingProvider(shop.pricingProvider, admin, writesEnabled);
  const compatibility = await provider.verifyCompatibility({
    shopDomain: session.shop,
    distribution: probe.distribution,
    planName: probe.planName,
    functionsAvailable: probe.error ? null : probe.functionsAvailable,
    partnerDevelopment: probe.partnerDevelopment || probe.isPlusEligible,
  });

  // Persist latest probe so Home / other pages stop showing stale “Setup required”
  if (
    shop.pricingStatus !== compatibility.status ||
    shop.pricingCompatibility !== compatibility.compatibility
  ) {
    await prisma.shop.update({
      where: { id: shop.id },
      data: {
        pricingStatus: compatibility.status,
        pricingCompatibility: compatibility.compatibility,
        pricingCompatibilityNote: compatibility.message,
        pricingExternalIds: {
          ...((shop.pricingExternalIds as Record<string, unknown>) || {}),
          shopGid: probe.shopGid,
          functionId: probe.functionId,
          discountGid:
            probe.discountGid ||
            ((shop.pricingExternalIds as { discountGid?: string })?.discountGid ?? null),
          planName: probe.planName,
          lastProbedAt: new Date().toISOString(),
        },
      },
    });
  }

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
      pricingStatus: compatibility.status,
      pricingCompatibility: compatibility.compatibility,
      discountCombination: shop.discountCombination,
    },
    spendPolicy,
    excludedProducts,
    excludedCollections,
    providerLabel: provider.capability.displayName,
    liveCompatibility: compatibility,
    writesEnabled,
    probe: {
      planName: probe.planName,
      distribution: probe.distribution,
      functionsAvailable: probe.functionsAvailable,
      functionTitle: probe.functionTitle,
      functionId: probe.functionId,
      discountGid: probe.discountGid,
      isPlusEligible: probe.isPlusEligible,
      error: probe.error,
    },
    storefrontPricing: {
      status: "ACTIVE",
      message:
        "Customer tags (vpm-approved, vpm-pct-*, Wholesale / Distributor / Retailer) drive prices on the theme. No checkout Function required.",
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

      const distribution = resolveAppDistribution();
      const probe = await probePricingCompatibility(admin, distribution);
      const writesEnabled = shopCheckoutWritesEnabled(shop.pricingExternalIds);
      const provider = getPricingProvider("discount_function", admin, writesEnabled);
      const compatibility = await provider.verifyCompatibility({
        shopDomain: session.shop,
        distribution: probe.distribution,
        planName: probe.planName,
        functionsAvailable: probe.error ? null : probe.functionsAvailable,
        partnerDevelopment: probe.partnerDevelopment || probe.isPlusEligible,
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

    if (intent === "activate_checkout") {
      const distribution = resolveAppDistribution();
      const probe = await probePricingCompatibility(admin, distribution);
      if (probe.error) {
        return { ok: false, message: `Could not verify shop: ${probe.error}` };
      }

      const provider = getPricingProvider("discount_function", admin, false);
      const compatibility = await provider.verifyCompatibility({
        shopDomain: session.shop,
        distribution: probe.distribution,
        planName: probe.planName,
        functionsAvailable: probe.functionsAvailable,
        partnerDevelopment: probe.partnerDevelopment || probe.isPlusEligible,
      });

      if (compatibility.compatibility === "UNSUPPORTED") {
        await prisma.shop.update({
          where: { id: shop.id },
          data: {
            pricingStatus: compatibility.status,
            pricingCompatibility: compatibility.compatibility,
            pricingCompatibilityNote: compatibility.message,
          },
        });
        return {
          ok: false,
          message: compatibility.message,
        };
      }

      if (!probe.functionId) {
        await prisma.shop.update({
          where: { id: shop.id },
          data: {
            pricingStatus: "NOT_CONFIGURED",
            pricingCompatibility: "SETUP_REQUIRED",
            pricingCompatibilityNote:
              "Deploy the app with the Discount Function extension, then try Activate again.",
          },
        });
        return {
          ok: false,
          message:
            "No Discount Function found. Deploy the app (shopify app deploy) so the volume-tier-discount extension registers, then click Activate again. Storefront tag pricing already works.",
        };
      }

      let discountGid =
        probe.discountGid ||
        ((shop.pricingExternalIds as { discountGid?: string } | null)?.discountGid ?? null);

      if (!discountGid) {
        const created = await createVolumeAutomaticDiscount(admin, probe.functionId);
        if (created.error || !created.discountGid) {
          return {
            ok: false,
            message: created.error || "Could not create automatic app discount.",
          };
        }
        discountGid = created.discountGid;
      }

      const tiers = await prisma.pricingTier.findMany({
        where: { shopId: shop.id, isActive: true, isArchived: false },
        orderBy: { displayOrder: "asc" },
      });

      const writeProvider = getPricingProvider("discount_function", admin, true);
      const sync = await writeProvider.syncShopConfig({
        shopDomain: session.shop,
        shopGid: probe.shopGid || undefined,
        discountGid: discountGid || undefined,
        currencyCode: shop.currencyCode,
        discountCombination: shop.discountCombination,
        configVersion: shop.settingsVersion + 1,
        tiers: tiers.map((t) => ({
          id: t.id,
          name: t.name,
          discountBps: t.discountBps,
          isActive: t.isActive,
        })),
        externalIds: {
          shopGid: probe.shopGid || undefined,
          discountGid: discountGid || undefined,
          functionId: probe.functionId,
        },
      });

      await prisma.shop.update({
        where: { id: shop.id },
        data: {
          pricingProvider: "discount_function",
          pricingStatus: sync.status === "SYNCED" || sync.status === "READY" ? "SYNCED" : sync.status,
          pricingCompatibility: "SUPPORTED",
          pricingCompatibilityNote: sync.message,
          settingsVersion: { increment: 1 },
          pricingExternalIds: {
            ...((shop.pricingExternalIds as Record<string, unknown>) || {}),
            shopGid: probe.shopGid,
            functionId: probe.functionId,
            discountGid,
            checkoutWritesEnabled: true,
            planName: probe.planName,
            activatedAt: new Date().toISOString(),
          },
        },
      });

      await writeAuditLog(prisma, {
        shopId: shop.id,
        actor: session.shop,
        action: "pricing.activate_checkout",
        entityType: "Shop",
        entityId: shop.id,
        summary: "Activated checkout Discount Function pricing",
        details: { discountGid, functionId: probe.functionId, sync },
      });

      return {
        ok: true,
        message:
          sync.status === "SYNCED"
            ? "Checkout pricing activated. Storefront tags and checkout Function discounts are both live."
            : `Checkout writes enabled. ${sync.message}`,
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
  const checkoutReady =
    data.shop.pricingCompatibility === "SUPPORTED" &&
    (data.shop.pricingStatus === "READY" || data.shop.pricingStatus === "SYNCED");
  const checkoutActive = data.writesEnabled && checkoutReady;

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
            discounted price. This path does not need Shopify Functions.
          </s-paragraph>
        </div>
      </s-section>

      <s-section heading="Checkout pricing (optional)">
        <div className="vpm-panel vpm-stack-tight">
          <s-paragraph>
            Provider: <s-text type="strong">{data.providerLabel}</s-text>
            {data.probe.planName ? (
              <>
                {" "}
                · Plan: <s-text type="strong">{data.probe.planName}</s-text>
              </>
            ) : null}
            {" "}
            · Distribution: <s-text type="strong">{data.probe.distribution}</s-text>
          </s-paragraph>

          {checkoutActive ? (
            <s-banner tone="success" heading="Checkout Function active">
              Automatic discount is linked and tier metafield writes are enabled.
            </s-banner>
          ) : (
            <PricingStatusBadge
              status={data.shop.pricingStatus}
              compatibility={data.shop.pricingCompatibility}
            />
          )}

          <s-paragraph>{data.liveCompatibility.message}</s-paragraph>

          {data.probe.functionTitle ? (
            <s-paragraph>
              Function found: <s-text type="strong">{data.probe.functionTitle}</s-text>
            </s-paragraph>
          ) : (
            <s-paragraph>
              No Discount Function registered yet — deploy the app first if you want checkout discounts.
            </s-paragraph>
          )}

          {data.probe.error ? (
            <s-banner tone="critical" heading="Probe error">
              {data.probe.error}
            </s-banner>
          ) : null}

          <s-paragraph>
            <s-text type="strong">What “Setup required” meant:</s-text> only the optional checkout
            Function path was unverified. It does <s-text type="strong">not</s-text> mean storefront
            wholesale pricing is broken.
          </s-paragraph>

          {!checkoutActive ? (
            <Form method="post">
              <input type="hidden" name="intent" value="activate_checkout" />
              <SubmitButton>
                {checkoutReady
                  ? "Activate checkout pricing"
                  : "Verify & activate checkout pricing"}
              </SubmitButton>
            </Form>
          ) : null}
        </div>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);

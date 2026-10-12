/**
 * Discount Function pricing provider.
 *
 * Compatibility:
 * - Public App Store apps with Functions: available on all Shopify plans.
 * - Custom-distributed apps with Functions: Shopify Plus (or Enterprise) only.
 *
 * Approach:
 * - Automatic app discount owned by a Discount Function extension.
 * - Function reads customer metafield `$app:volume_pricing.tier`
 *   and discount metafield `$app:volume_pricing.function_configuration`.
 * - Rejects browser-supplied discount percentages; only trusted metafields apply.
 */

import type {
  CustomerPricingTarget,
  PricingProvider,
  PricingProviderCapability,
  PricingProviderResult,
  ShopPricingConfig,
} from "./types";

export const DISCOUNT_FUNCTION_PROVIDER_ID = "discount_function";

export const discountFunctionCapability = {
  id: DISCOUNT_FUNCTION_PROVIDER_ID,
  displayName: "Shopify Discount Function",
  description:
    "Applies an automatic percentage discount at checkout based on the customer's app-managed tier metafield. Deterministic, no network calls during checkout.",
  requiresShopifyPlus: false,
  requiresAppStoreDistributionForNonPlus: true,
  maxTiers: null,
  appliesAtCheckout: true,
  setupSteps: [
    "Confirm app distribution (App Store vs custom) and store plan",
    "Deploy the volume-tier-discount Function extension",
    "Create the automatic app discount via Admin API",
    "Sync tier configuration metafields",
    "Assign customer tier metafields and place a test order while logged in",
  ],
} as const;

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export class DiscountFunctionPricingProvider implements PricingProvider {
  readonly capability: PricingProviderCapability = {
    id: DISCOUNT_FUNCTION_PROVIDER_ID,
    displayName: discountFunctionCapability.displayName,
    description: discountFunctionCapability.description,
    requiresShopifyPlus: discountFunctionCapability.requiresShopifyPlus,
    requiresAppStoreDistributionForNonPlus:
      discountFunctionCapability.requiresAppStoreDistributionForNonPlus,
    maxTiers: discountFunctionCapability.maxTiers,
    appliesAtCheckout: discountFunctionCapability.appliesAtCheckout,
    setupSteps: [...discountFunctionCapability.setupSteps],
  };

  constructor(
    private admin: AdminGraphql | null,
    private options: {
      writesEnabled: boolean;
      functionHandle?: string;
    } = { writesEnabled: false },
  ) {}

  async verifyCompatibility(ctx: {
    shopDomain: string;
    planName?: string | null;
    distribution: "app_store" | "custom" | "unknown";
    functionsAvailable?: boolean | null;
    partnerDevelopment?: boolean;
  }): Promise<PricingProviderResult> {
    if (ctx.functionsAvailable == null) {
      return {
        status: "NOT_CONFIGURED",
        compatibility: "SETUP_REQUIRED",
        message:
          "Checkout Function status has not been verified yet. Click “Verify & activate checkout pricing” in Settings. Storefront wholesale prices from customer tags already work without this.",
      };
    }

    const plan = (ctx.planName || "").toLowerCase();
    const isPlus =
      Boolean(ctx.partnerDevelopment) ||
      plan.includes("plus") ||
      plan.includes("enterprise") ||
      plan.includes("partner") ||
      plan.includes("development");

    if (ctx.distribution === "custom" && !isPlus) {
      return {
        status: "UNSUPPORTED",
        compatibility: "UNSUPPORTED",
        message:
          "Checkout Function discounts need Shopify Plus (or a partner development store) for custom apps. Storefront tag pricing still works — buyers see wholesale prices on the theme.",
      };
    }

    if (ctx.functionsAvailable === false) {
      return {
        status: "NOT_CONFIGURED",
        compatibility: "SETUP_REQUIRED",
        message:
          "No Discount Function is registered for this app yet. Deploy the app (with the volume-tier-discount extension), then click Activate. Storefront tag pricing is unaffected.",
      };
    }

    return {
      status: "READY",
      compatibility: "SUPPORTED",
      message:
        "Checkout Discount Function is available. Activate to create the automatic discount and sync tier metafields at checkout. Storefront tag pricing already works.",
    };
  }

  async syncShopConfig(config: ShopPricingConfig): Promise<PricingProviderResult> {
    if (!this.options.writesEnabled || !this.admin) {
      return {
        status: "NOT_CONFIGURED",
        compatibility: "SETUP_REQUIRED",
        message:
          "Shop tier configuration prepared locally. Shopify discount writes are disabled until pricing compatibility is verified and writes are enabled.",
        details: {
          configVersion: config.configVersion,
          tierCount: config.tiers.filter((t) => t.isActive).length,
        },
      };
    }

    const metafieldValue = JSON.stringify({
      configVersion: config.configVersion,
      currencyCode: config.currencyCode,
      discountCombination: config.discountCombination,
      tiers: Object.fromEntries(
        config.tiers.filter((t) => t.isActive).map((t) => [t.id, t.discountBps]),
      ),
    });

    const shopGid =
      config.shopGid ||
      (await this.resolveShopGid()) ||
      config.externalIds?.shopGid;
    const discountGid = config.discountGid || config.externalIds?.discountGid;

    const metafields: Array<Record<string, string>> = [];
    if (shopGid) {
      metafields.push({
        ownerId: shopGid,
        namespace: "$app:volume_pricing",
        key: "tier_config",
        type: "json",
        value: metafieldValue,
      });
    }
    if (discountGid) {
      metafields.push({
        ownerId: discountGid,
        namespace: "$app:volume_pricing",
        key: "function_configuration",
        type: "json",
        value: metafieldValue,
      });
    }

    if (!metafields.length) {
      return {
        status: "FAILED",
        compatibility: "SUPPORTED",
        message:
          "Cannot sync shop config: missing Shop GID and automatic discount GID. Create the automatic discount first.",
      };
    }

    const response = await this.admin.graphql(
      `#graphql
      mutation volumePricingShopMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key namespace }
          userErrors { field message }
        }
      }`,
      { variables: { metafields } },
    );

    const json = await response.json();
    const errors = json?.data?.metafieldsSet?.userErrors ?? [];
    if (errors.length) {
      return {
        status: "FAILED",
        compatibility: "SUPPORTED",
        message: errors.map((e: { message: string }) => e.message).join("; "),
        details: { errors },
      };
    }

    return {
      status: "SYNCED",
      compatibility: "SUPPORTED",
      message: "Shop tier configuration synchronized for Discount Function.",
      details: { configVersion: config.configVersion, owners: metafields.map((m) => m.ownerId) },
    };
  }

  async syncCustomer(target: CustomerPricingTarget): Promise<PricingProviderResult> {
    if (!this.options.writesEnabled || !this.admin) {
      return {
        status: "NOT_CONFIGURED",
        compatibility: "SETUP_REQUIRED",
        message: `Customer ${target.shopifyCustomerId} tier assignment stored. Checkout Function sync pending; wholesale tags still sync separately.`,
        details: {
          tierId: target.tierId,
          discountBps: target.discountBps,
          assignmentVersion: target.assignmentVersion,
        },
      };
    }

    const value = JSON.stringify({
      tierId: target.tierId,
      discountBps: target.discountBps,
      configVersion: target.configVersion,
      assignmentVersion: target.assignmentVersion,
    });

    const response = await this.admin.graphql(
      `#graphql
      mutation volumePricingCustomerMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: target.shopifyCustomerId.startsWith("gid://")
                ? target.shopifyCustomerId
                : `gid://shopify/Customer/${target.shopifyCustomerId}`,
              namespace: "$app:volume_pricing",
              key: "tier",
              type: "json",
              value,
            },
          ],
        },
      },
    );

    const json = await response.json();
    const errors = json?.data?.metafieldsSet?.userErrors ?? [];
    if (errors.length) {
      return {
        status: "FAILED",
        compatibility: "SUPPORTED",
        message: errors.map((e: { message: string }) => e.message).join("; "),
      };
    }

    return {
      status: "SYNCED",
      compatibility: "SUPPORTED",
      externalRef: `${target.shopifyCustomerId}:${target.tierId}`,
      message: "Customer tier metafield synchronized for checkout Function.",
    };
  }

  async clearCustomer(
    target: Pick<CustomerPricingTarget, "shopDomain" | "shopifyCustomerId">,
  ): Promise<PricingProviderResult> {
    if (!this.options.writesEnabled || !this.admin) {
      return {
        status: "NOT_CONFIGURED",
        compatibility: "SETUP_REQUIRED",
        message: "Clear customer pricing skipped — writes not enabled.",
      };
    }
    return this.syncCustomer({
      shopDomain: target.shopDomain,
      shopifyCustomerId: target.shopifyCustomerId,
      tierId: null,
      discountBps: 0,
      tierName: null,
      configVersion: 0,
      assignmentVersion: 0,
    });
  }

  private async resolveShopGid(): Promise<string | null> {
    if (!this.admin) return null;
    try {
      const res = await this.admin.graphql(`#graphql query { shop { id } }`);
      const json = await res.json();
      return (json?.data?.shop?.id as string) || null;
    } catch {
      return null;
    }
  }
}

export function getPricingProvider(
  id: string,
  admin: AdminGraphql | null,
  writesEnabled: boolean,
): PricingProvider {
  switch (id) {
    case DISCOUNT_FUNCTION_PROVIDER_ID:
    default:
      return new DiscountFunctionPricingProvider(admin, { writesEnabled });
  }
}

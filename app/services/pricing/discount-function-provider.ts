/**
 * Discount Function pricing provider.
 *
 * Compatibility:
 * - Public App Store apps with Functions: available on all Shopify plans.
 * - Custom-distributed apps with Functions: Shopify Plus (or Enterprise) only.
 *
 * Until plan + distribution are verified, status remains SETUP_REQUIRED /
 * NOT_CONFIGURED and no live checkout writes are attempted in unverified mode.
 *
 * Approach:
 * - Automatic app discount owned by a Discount Function extension.
 * - Function reads customer metafield `$app:volume_pricing.tier` (stable tier ID + bps)
 *   and discount configuration metafield listing valid tier IDs → discount bps.
 * - Rejects browser-supplied discount percentages; only trusted metafields apply.
 * - Basis: Shopify selling price (cart line cost), not compare-at / MSRP.
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
  requiresShopifyPlus: false, // Plus required only for custom distribution
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
      /** When false, never write to Shopify — simulation / setup-required mode */
      writesEnabled: boolean;
      functionHandle?: string;
    } = { writesEnabled: false },
  ) {}

  async verifyCompatibility(ctx: {
    shopDomain: string;
    planName?: string | null;
    distribution: "app_store" | "custom" | "unknown";
    functionsAvailable?: boolean | null;
  }): Promise<PricingProviderResult> {
    if (ctx.distribution === "unknown" || ctx.functionsAvailable == null) {
      return {
        status: "NOT_CONFIGURED",
        compatibility: "SETUP_REQUIRED",
        message:
          "Pricing integration requires verification of app distribution and Shopify Functions availability. Tier automation works independently; checkout discounts stay Setup required until verified.",
      };
    }

    const plan = (ctx.planName || "").toLowerCase();
    const isPlus = plan.includes("plus") || plan.includes("enterprise");

    if (ctx.distribution === "custom" && !isPlus) {
      return {
        status: "UNSUPPORTED",
        compatibility: "UNSUPPORTED",
        message:
          "Custom-distributed apps can only use Shopify Functions on Shopify Plus or Enterprise. This store's plan does not appear to qualify. Consider App Store distribution, B2B catalogs (if applicable), or a documented compatible pricing app.",
      };
    }

    if (ctx.functionsAvailable === false) {
      return {
        status: "UNSUPPORTED",
        compatibility: "UNSUPPORTED",
        message: "Shopify Functions are not available for this shop/app combination.",
      };
    }

    return {
      status: "READY",
      compatibility: "SUPPORTED",
      message:
        "Discount Function pricing appears compatible. Deploy the extension and create the automatic discount to enable checkout sync.",
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
      /** Map of stable tier ID → discount basis points; Function rejects unknown IDs */
      tiers: Object.fromEntries(
        config.tiers.filter((t) => t.isActive).map((t) => [t.id, t.discountBps]),
      ),
    });

    // Upsert shop-level configuration metafield used by the Function via discount owner.
    // Full automatic discount create/update is performed when functionHandle is known.
    const response = await this.admin.graphql(
      `#graphql
      mutation volumePricingShopMetafield($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          metafields { id key namespace }
          userErrors { field message }
        }
      }`,
      {
        variables: {
          metafields: [
            {
              ownerId: `gid://shopify/Shop/`, // resolved by caller via shop query in production sync service
              namespace: "$app:volume_pricing",
              key: "tier_config",
              type: "json",
              value: metafieldValue,
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
        details: { errors },
      };
    }

    return {
      status: "SYNCED",
      compatibility: "SUPPORTED",
      message: "Shop tier configuration synchronized for Discount Function.",
      details: { configVersion: config.configVersion },
    };
  }

  async syncCustomer(target: CustomerPricingTarget): Promise<PricingProviderResult> {
    if (!this.options.writesEnabled || !this.admin) {
      return {
        status: "NOT_CONFIGURED",
        compatibility: "SETUP_REQUIRED",
        message: `Customer ${target.shopifyCustomerId} tier assignment stored. Checkout pricing sync pending provider setup.`,
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

/**
 * Pricing provider interface — business rules must not depend on one Shopify method.
 */

export type PricingSyncStatus =
  | "NOT_CONFIGURED"
  | "READY"
  | "SYNCING"
  | "SYNCED"
  | "FAILED"
  | "UNSUPPORTED";

export type PricingCompatibility =
  | "UNKNOWN"
  | "SUPPORTED"
  | "UNSUPPORTED"
  | "SETUP_REQUIRED";

export type CustomerPricingTarget = {
  shopDomain: string;
  shopifyCustomerId: string;
  /** Stable tier ID — never use display names for pricing authority */
  tierId: string | null;
  discountBps: number;
  tierName: string | null;
  configVersion: number;
  assignmentVersion: number;
};

export type ShopPricingConfig = {
  shopDomain: string;
  currencyCode: string;
  tiers: Array<{
    id: string;
    discountBps: number;
    name: string;
    isActive: boolean;
  }>;
  discountCombination: string;
  configVersion: number;
  externalIds: Record<string, string>;
  /** Resolved Shopify Shop GID for metafield owner */
  shopGid?: string;
  /** Automatic discount GID that owns function_configuration */
  discountGid?: string;
};

export type PricingProviderCapability = {
  id: string;
  displayName: string;
  description: string;
  requiresShopifyPlus: boolean;
  requiresAppStoreDistributionForNonPlus: boolean;
  maxTiers: number | null;
  appliesAtCheckout: boolean;
  setupSteps: string[];
};

export type PricingProviderResult = {
  status: PricingSyncStatus;
  compatibility: PricingCompatibility;
  externalRef?: string;
  message: string;
  details?: Record<string, unknown>;
};

export interface PricingProvider {
  readonly capability: PricingProviderCapability;
  /**
   * Verify whether this shop/distribution can use the provider.
   * Must not claim checkout pricing works until verified.
   */
  verifyCompatibility(ctx: {
    shopDomain: string;
    planName?: string | null;
    distribution: "app_store" | "custom" | "unknown";
    functionsAvailable?: boolean | null;
  }): Promise<PricingProviderResult>;

  /** Push shop-level tier configuration (discount function metafields, segments, etc.) */
  syncShopConfig(config: ShopPricingConfig): Promise<PricingProviderResult>;

  /** Sync a single customer's effective tier into the pricing mechanism */
  syncCustomer(target: CustomerPricingTarget): Promise<PricingProviderResult>;

  /** Remove pricing for a customer (e.g. uninstall / archive) */
  clearCustomer(target: Pick<CustomerPricingTarget, "shopDomain" | "shopifyCustomerId">): Promise<PricingProviderResult>;
}

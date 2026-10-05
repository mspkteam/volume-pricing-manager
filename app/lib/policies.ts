/**
 * Default policies and HVAC starter preset.
 * Preset is optional and fully editable — never hardcoded into business logic.
 */

import type { MoneyMinor } from "./money";
import { percentToBps, toMinorUnits } from "./money";

export type SpendPolicy = {
  rollingPeriodMonths: number;
  includeTax: boolean;
  includeShipping: boolean;
  excludeGiftCards: boolean;
  excludeCancelled: boolean;
  excludeTestOrders: boolean;
  /** Shopify financial statuses that qualify (paid merchandise) */
  eligiblePaymentStatuses: string[];
  /** Empty = all channels; otherwise allow-list of source_name / channel */
  includedSalesChannels: string[];
  /** Product GIDs to exclude */
  excludedProductIds: string[];
  /** Collection GIDs to exclude */
  excludedCollectionIds: string[];
  /**
   * When true, if order.current_subtotal already reflects refunds, do not
   * additionally subtract refund line amounts (avoids double deduction).
   */
  preferOrderAdjustedTotals: boolean;
  /**
   * If history is incomplete, do not auto-downgrade existing effective tiers.
   */
  protectFromIncompleteHistoryDowngrade: boolean;
};

export type AutomationPolicy = {
  upgradeMode: "immediate" | "next_review";
  downgradeMode: "immediate" | "grace_period" | "next_review";
  gracePeriodDays: number;
  reviewInterval: "none" | "quarterly" | "semi_annual" | "annual";
  /** Day-of-month style anchor for reviews (1-28) in shop timezone */
  reviewAnchorDay: number;
  pauseAutomation: boolean;
};

export type TierInput = {
  name: string;
  description: string;
  badgeColor: string;
  minSpend: string; // major units decimal string
  discountPercent: number;
  requiresApproval: boolean;
  requiresLicense?: boolean;
  requiresResaleCert?: boolean;
  requiresPurchaseAgreement?: boolean;
  minPurchaseHistoryMonths?: number | null;
  allowProjectedVolume?: boolean;
  isActive: boolean;
  isFallback?: boolean;
  displayOrder: number;
};

export const DEFAULT_SPEND_POLICY: SpendPolicy = {
  rollingPeriodMonths: 12,
  includeTax: false,
  includeShipping: false,
  excludeGiftCards: true,
  excludeCancelled: true,
  excludeTestOrders: true,
  eligiblePaymentStatuses: ["paid", "partially_paid", "partially_refunded", "refunded"],
  includedSalesChannels: [],
  excludedProductIds: [],
  excludedCollectionIds: [],
  preferOrderAdjustedTotals: true,
  protectFromIncompleteHistoryDowngrade: true,
};

export const DEFAULT_AUTOMATION_POLICY: AutomationPolicy = {
  upgradeMode: "immediate",
  downgradeMode: "grace_period",
  gracePeriodDays: 30,
  reviewInterval: "quarterly",
  reviewAnchorDay: 1,
  pauseAutomation: false,
};

/** Optional HVAC / trade starter preset — editable, not required */
export function hvacStarterPreset(): TierInput[] {
  return [
    {
      name: "Retail",
      description: "Standard list pricing for new and occasional buyers.",
      badgeColor: "#6D7175",
      minSpend: "0",
      discountPercent: 0,
      requiresApproval: false,
      isActive: true,
      isFallback: true,
      displayOrder: 0,
    },
    {
      name: "Tier C",
      description: "Entry trade pricing for qualifying purchase volume.",
      badgeColor: "#B98900",
      minSpend: "2500",
      discountPercent: 15,
      requiresApproval: true,
      requiresLicense: true,
      isActive: true,
      displayOrder: 1,
    },
    {
      name: "Tier B",
      description: "Mid-volume contractor and partner pricing.",
      badgeColor: "#2C6ECB",
      minSpend: "15000",
      discountPercent: 25,
      requiresApproval: true,
      requiresLicense: true,
      isActive: true,
      displayOrder: 2,
    },
    {
      name: "Tier A",
      description: "Highest volume distributor / preferred partner pricing.",
      badgeColor: "#008060",
      minSpend: "50000",
      discountPercent: 40,
      requiresApproval: true,
      requiresLicense: true,
      requiresResaleCert: true,
      isActive: true,
      displayOrder: 3,
    },
  ];
}

export function tierInputToPersisted(tier: TierInput, currencyExponent = 2) {
  return {
    name: tier.name.trim(),
    description: tier.description,
    badgeColor: tier.badgeColor,
    minSpendMinor: toMinorUnits(tier.minSpend, currencyExponent),
    discountBps: percentToBps(tier.discountPercent),
    requiresApproval: tier.requiresApproval,
    requiresLicense: Boolean(tier.requiresLicense),
    requiresResaleCert: Boolean(tier.requiresResaleCert),
    requiresPurchaseAgreement: Boolean(tier.requiresPurchaseAgreement),
    minPurchaseHistoryMonths: tier.minPurchaseHistoryMonths ?? null,
    allowProjectedVolume: Boolean(tier.allowProjectedVolume),
    isActive: tier.isActive,
    isFallback: Boolean(tier.isFallback),
    displayOrder: tier.displayOrder,
  };
}

export type TierRange = {
  id: string;
  name: string;
  minSpendMinor: MoneyMinor;
  /** Exclusive upper bound; null = no upper bound */
  maxSpendMinorExclusive: MoneyMinor | null;
  discountBps: number;
};

/**
 * Build half-open spend ranges from ordered minimum thresholds.
 * A tier at 2500 runs up to (but does not include) the next threshold.
 */
export function buildSpendRanges(
  tiers: Array<{ id: string; name: string; minSpendMinor: MoneyMinor | bigint; discountBps: number; isActive: boolean; isArchived: boolean }>,
): TierRange[] {
  const active = tiers
    .filter((t) => t.isActive && !t.isArchived)
    .map((t) => ({
      ...t,
      minSpendMinor: BigInt(t.minSpendMinor),
    }))
    .sort((a, b) => {
      if (a.minSpendMinor === b.minSpendMinor) return a.name.localeCompare(b.name);
      return a.minSpendMinor < b.minSpendMinor ? -1 : 1;
    });

  return active.map((tier, index) => {
    const next = active[index + 1];
    return {
      id: tier.id,
      name: tier.name,
      minSpendMinor: tier.minSpendMinor,
      maxSpendMinorExclusive: next ? next.minSpendMinor : null,
      discountBps: tier.discountBps,
    };
  });
}

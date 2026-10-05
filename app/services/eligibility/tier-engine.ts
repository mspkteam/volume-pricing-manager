/**
 * Tier validation and qualification engine.
 * No hardcoded tier names — all logic uses stable IDs and numeric thresholds.
 */

import { buildSpendRanges, type TierInput } from "../../lib/policies";
import { percentToBps, toMinorUnits, type MoneyMinor } from "../../lib/money";

export type TierRecord = {
  id: string;
  name: string;
  minSpendMinor: MoneyMinor | bigint;
  discountBps: number;
  requiresApproval: boolean;
  requiresLicense: boolean;
  requiresResaleCert: boolean;
  requiresPurchaseAgreement: boolean;
  minPurchaseHistoryMonths: number | null;
  allowProjectedVolume: boolean;
  isActive: boolean;
  isArchived: boolean;
  isFallback: boolean;
  displayOrder: number;
};

export type EligibilityFlags = {
  businessApproved: boolean;
  licenseVerified: boolean;
  resaleCertVerified: boolean;
  purchaseAgreementVerified: boolean;
  projectedVolumeApproved: boolean;
  firstOrderAt: Date | null;
  now: Date;
};

export type QualificationResult = {
  calculatedTier: TierRecord | null;
  blockingReasons: string[];
  nextEligibleTier: TierRecord | null;
  spendNeededMinor: MoneyMinor;
  evaluatedTiers: Array<{
    tierId: string;
    tierName: string;
    spendOk: boolean;
    eligibilityOk: boolean;
    reasons: string[];
  }>;
};

export class TierValidationError extends Error {
  constructor(
    message: string,
    public fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "TierValidationError";
  }
}

export function validateTierInputs(tiers: TierInput[], currencyExponent = 2): void {
  const fieldErrors: Record<string, string> = {};
  if (tiers.length === 0) return;

  const names = new Set<string>();
  const activeThresholds = new Map<string, string>();
  let fallbackCount = 0;

  for (const [i, tier] of tiers.entries()) {
    const prefix = `tiers[${i}]`;
    const name = tier.name.trim();
    if (!name) fieldErrors[`${prefix}.name`] = "Name is required";
    if (names.has(name.toLowerCase())) {
      fieldErrors[`${prefix}.name`] = "Tier names must be unique";
    }
    names.add(name.toLowerCase());

    try {
      const minor = toMinorUnits(tier.minSpend, currencyExponent);
      if (minor < 0n) fieldErrors[`${prefix}.minSpend`] = "Must be nonnegative";
      if (tier.isActive) {
        const key = minor.toString();
        if (activeThresholds.has(key)) {
          fieldErrors[`${prefix}.minSpend`] =
            `Active tiers cannot share the same minimum spend (conflicts with ${activeThresholds.get(key)})`;
        } else {
          activeThresholds.set(key, name);
        }
      }
    } catch {
      fieldErrors[`${prefix}.minSpend`] = "Invalid monetary amount";
    }

    try {
      percentToBps(tier.discountPercent);
    } catch {
      fieldErrors[`${prefix}.discountPercent`] = "Discount must be 0–100% in 0.01 increments";
    }

    if (tier.isFallback) fallbackCount += 1;
  }

  if (fallbackCount > 1) {
    fieldErrors.fallback = "Only one fallback tier is allowed";
  }

  if (Object.keys(fieldErrors).length > 0) {
    throw new TierValidationError("Tier configuration is invalid", fieldErrors);
  }
}

function monthsBetween(start: Date, end: Date): number {
  const years = end.getUTCFullYear() - start.getUTCFullYear();
  const months = end.getUTCMonth() - start.getUTCMonth();
  let total = years * 12 + months;
  if (end.getUTCDate() < start.getUTCDate()) total -= 1;
  return Math.max(0, total);
}

export function evaluateEligibility(
  tier: TierRecord,
  flags: EligibilityFlags,
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  if (tier.requiresApproval && !flags.businessApproved) {
    reasons.push("Business approval required");
  }
  if (tier.requiresLicense && !flags.licenseVerified) {
    reasons.push("Business license / contractor ID verification required");
  }
  if (tier.requiresResaleCert && !flags.resaleCertVerified) {
    reasons.push("Resale certificate verification required");
  }
  if (tier.requiresPurchaseAgreement && !flags.purchaseAgreementVerified) {
    reasons.push("Purchase agreement verification required");
  }
  if (tier.minPurchaseHistoryMonths != null && tier.minPurchaseHistoryMonths > 0) {
    if (!flags.firstOrderAt) {
      reasons.push(`Minimum ${tier.minPurchaseHistoryMonths} months of purchase history required`);
    } else {
      const months = monthsBetween(flags.firstOrderAt, flags.now);
      if (months < tier.minPurchaseHistoryMonths) {
        reasons.push(
          `Purchase history is ${months} months; ${tier.minPurchaseHistoryMonths} months required`,
        );
      }
    }
  }
  // Projected volume can satisfy spend-like assignment only when allowed and approved;
  // it does not bypass approval/license flags above.
  if (
    !reasons.length &&
    tier.allowProjectedVolume &&
    flags.projectedVolumeApproved &&
    !flags.businessApproved &&
    tier.requiresApproval
  ) {
    // Projected volume still needs approval path — keep requiresApproval authoritative.
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Choose the highest qualifying tier by minimum spend among those that also
 * pass eligibility. High spend without approval falls to the next eligible tier.
 */
export function qualifyCustomer(
  spendMinor: MoneyMinor,
  tiers: TierRecord[],
  flags: EligibilityFlags,
): QualificationResult {
  const active = tiers
    .filter((t) => t.isActive && !t.isArchived)
    .map((t) => ({ ...t, minSpendMinor: BigInt(t.minSpendMinor) }))
    .sort((a, b) => (a.minSpendMinor < b.minSpendMinor ? 1 : a.minSpendMinor > b.minSpendMinor ? -1 : 0));

  const evaluated: QualificationResult["evaluatedTiers"] = [];
  let calculated: TierRecord | null = null;
  let blockingForTop: string[] = [];

  for (const tier of active) {
    const spendOk = spendMinor >= BigInt(tier.minSpendMinor);
    const elig = evaluateEligibility(tier, flags);
    evaluated.push({
      tierId: tier.id,
      tierName: tier.name,
      spendOk,
      eligibilityOk: elig.ok,
      reasons: [...(!spendOk ? [`Spend below ${tier.name} minimum`] : []), ...elig.reasons],
    });
    if (spendOk && elig.ok && !calculated) {
      calculated = tier;
    }
    if (spendOk && !elig.ok && !calculated && blockingForTop.length === 0) {
      blockingForTop = elig.reasons;
    }
  }

  // Fallback if nothing matched
  if (!calculated) {
    calculated = tiers.find((t) => t.isFallback && t.isActive && !t.isArchived) ?? null;
  }

  // Next eligible by spend (may still need eligibility)
  const ascending = [...active].sort((a, b) =>
    a.minSpendMinor < b.minSpendMinor ? -1 : a.minSpendMinor > b.minSpendMinor ? 1 : 0,
  );
  let nextEligible: TierRecord | null = null;
  let spendNeeded: MoneyMinor = 0n;
  const currentMin = calculated ? BigInt(calculated.minSpendMinor) : -1n;
  for (const tier of ascending) {
    if (BigInt(tier.minSpendMinor) > currentMin && BigInt(tier.minSpendMinor) > spendMinor) {
      nextEligible = tier;
      spendNeeded = BigInt(tier.minSpendMinor) - spendMinor;
      break;
    }
  }

  return {
    calculatedTier: calculated,
    blockingReasons: calculated ? [] : blockingForTop,
    nextEligibleTier: nextEligible,
    spendNeededMinor: spendNeeded,
    evaluatedTiers: evaluated,
  };
}

export function describeRanges(tiers: TierRecord[], currencyFormatter: (minor: MoneyMinor) => string) {
  return buildSpendRanges(tiers).map((r) => ({
    ...r,
    rangeLabel:
      r.maxSpendMinorExclusive == null
        ? `${currencyFormatter(r.minSpendMinor)} and above`
        : `${currencyFormatter(r.minSpendMinor)} up to (but not including) ${currencyFormatter(r.maxSpendMinorExclusive)}`,
  }));
}

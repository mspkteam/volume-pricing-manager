import { describe, expect, it } from "vitest";
import { toMinorUnits, fromMinorUnits, percentToBps, addMinor, subMinor } from "../app/lib/money";
import {
  computeRollingWindow,
  subtractCalendarMonths,
  daysInMonth,
  isWithinWindow,
} from "../app/lib/rolling-window";
import { buildSpendRanges, hvacStarterPreset } from "../app/lib/policies";
import {
  qualifyCustomer,
  validateTierInputs,
  type TierRecord,
} from "../app/services/eligibility/tier-engine";
import { decideAssignment } from "../app/services/assignment/decide-assignment";
import { calculateQualifyingSpend } from "../app/services/spend/calculate-spend";
import { DEFAULT_SPEND_POLICY, DEFAULT_AUTOMATION_POLICY } from "../app/lib/policies";

function tier(
  partial: Partial<TierRecord> & Pick<TierRecord, "id" | "name" | "minSpendMinor" | "discountBps">,
): TierRecord {
  return {
    requiresApproval: false,
    requiresLicense: false,
    requiresResaleCert: false,
    requiresPurchaseAgreement: false,
    minPurchaseHistoryMonths: null,
    allowProjectedVolume: false,
    isActive: true,
    isArchived: false,
    isFallback: false,
    displayOrder: 0,
    ...partial,
  };
}

describe("money", () => {
  it("converts decimal amounts without float error", () => {
    expect(toMinorUnits("19.99")).toBe(1999n);
    expect(toMinorUnits("0.10")).toBe(10n);
    expect(fromMinorUnits(1999n)).toBe("19.99");
    expect(addMinor(10n, 5n)).toBe(15n);
    expect(subMinor(10n, 15n)).toBe(-5n);
  });

  it("validates discount percentages", () => {
    expect(percentToBps(15)).toBe(1500);
    expect(percentToBps("40.00")).toBe(4000);
    expect(() => percentToBps(101)).toThrow();
    expect(() => percentToBps(-1)).toThrow();
  });
});

describe("rolling window", () => {
  it("clamps month-end dates and handles leap years", () => {
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(2025, 2)).toBe(28);
    expect(subtractCalendarMonths(2026, 3, 31, 1)).toEqual({ year: 2026, month: 2, day: 28 });
    expect(subtractCalendarMonths(2024, 3, 31, 1)).toEqual({ year: 2024, month: 2, day: 29 });
    expect(subtractCalendarMonths(2026, 3, 31, 12)).toEqual({ year: 2025, month: 3, day: 31 });
  });

  it("builds inclusive window in shop timezone", () => {
    const now = new Date("2026-03-15T18:00:00Z");
    const window = computeRollingWindow(now, 12, "America/New_York");
    expect(window.periodMonths).toBe(12);
    expect(window.start < window.end).toBe(true);
    expect(isWithinWindow(window.start, window)).toBe(true);
    expect(isWithinWindow(window.end, window)).toBe(true);
    expect(isWithinWindow(new Date(window.start.getTime() - 1), window)).toBe(false);
  });
});

describe("tier engine", () => {
  const tiers = [
    tier({ id: "retail", name: "Retail", minSpendMinor: 0n, discountBps: 0, isFallback: true }),
    tier({
      id: "bronze",
      name: "Bronze",
      minSpendMinor: 250000n,
      discountBps: 1500,
      requiresApproval: true,
    }),
    tier({
      id: "trade",
      name: "Trade Partner",
      minSpendMinor: 1500000n,
      discountBps: 2500,
      requiresApproval: true,
      requiresLicense: true,
    }),
    tier({
      id: "dist",
      name: "Distributor",
      minSpendMinor: 5000000n,
      discountBps: 4000,
      requiresApproval: true,
    }),
  ];

  it("supports arbitrary custom tier names without hardcoded A/B/C logic", () => {
    const result = qualifyCustomer(1500000n, tiers, {
      businessApproved: true,
      licenseVerified: true,
      resaleCertVerified: false,
      purchaseAgreementVerified: false,
      projectedVolumeApproved: false,
      firstOrderAt: new Date("2024-01-01"),
      now: new Date("2026-03-01"),
    });
    expect(result.calculatedTier?.name).toBe("Trade Partner");
  });

  it("does not grant unapproved high-spend customers the top tier", () => {
    const result = qualifyCustomer(6000000n, tiers, {
      businessApproved: false,
      licenseVerified: false,
      resaleCertVerified: false,
      purchaseAgreementVerified: false,
      projectedVolumeApproved: false,
      firstOrderAt: new Date("2024-01-01"),
      now: new Date("2026-03-01"),
    });
    expect(result.calculatedTier?.id).toBe("retail");
    expect(
      result.blockingReasons.length > 0 ||
        result.evaluatedTiers.some((e) => !e.eligibilityOk),
    ).toBe(true);
  });

  it("uses half-open spend ranges without overlapping maxima", () => {
    const ranges = buildSpendRanges(tiers);
    expect(ranges[0].maxSpendMinorExclusive).toBe(250000n);
    expect(ranges[1].minSpendMinor).toBe(250000n);
    expect(ranges[1].maxSpendMinorExclusive).toBe(1500000n);
    expect(ranges[ranges.length - 1].maxSpendMinorExclusive).toBeNull();
  });

  it("rejects duplicate active thresholds", () => {
    expect(() =>
      validateTierInputs([
        {
          name: "One",
          description: "",
          badgeColor: "#000",
          minSpend: "100",
          discountPercent: 5,
          requiresApproval: false,
          isActive: true,
          displayOrder: 0,
        },
        {
          name: "Two",
          description: "",
          badgeColor: "#000",
          minSpend: "100",
          discountPercent: 10,
          requiresApproval: false,
          isActive: true,
          displayOrder: 1,
        },
      ]),
    ).toThrow();
  });

  it("preserves identity semantics: renaming is unrelated to qualification IDs", () => {
    const renamed = tiers.map((t) =>
      t.id === "bronze" ? { ...t, name: "Contractor Silver" } : t,
    );
    const result = qualifyCustomer(300000n, renamed, {
      businessApproved: true,
      licenseVerified: false,
      resaleCertVerified: false,
      purchaseAgreementVerified: false,
      projectedVolumeApproved: false,
      firstOrderAt: new Date("2024-01-01"),
      now: new Date("2026-03-01"),
    });
    expect(result.calculatedTier?.id).toBe("bronze");
    expect(result.calculatedTier?.name).toBe("Contractor Silver");
  });
});

describe("assignment", () => {
  const tiers = [
    tier({ id: "a", name: "A", minSpendMinor: 0n, discountBps: 0, isFallback: true }),
    tier({ id: "b", name: "B", minSpendMinor: 10000n, discountBps: 1000 }),
  ];

  it("upgrades immediately by default", () => {
    const decision = decideAssignment({
      spendMinor: 10000n,
      tiers,
      flags: {
        businessApproved: true,
        licenseVerified: false,
        resaleCertVerified: false,
        purchaseAgreementVerified: false,
        projectedVolumeApproved: false,
        firstOrderAt: null,
        now: new Date(),
      },
      current: {
        calculatedTierId: "a",
        effectiveTierId: "a",
        pendingTierId: null,
        overrideTierId: null,
        overrideExpiresAt: null,
        overridePausesAutomation: false,
        gracePeriodEndsAt: null,
        nextReviewAt: null,
        historyStatus: "COMPLETE",
        protectFromIncompleteHistoryDowngrade: true,
      },
      policy: { ...DEFAULT_AUTOMATION_POLICY, upgradeMode: "immediate" },
      now: new Date(),
    });
    expect(decision.effectiveTierId).toBe("b");
    expect(decision.changeType).toBe("UPGRADE");
  });

  it("defers downgrade during grace period", () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const decision = decideAssignment({
      spendMinor: 0n,
      tiers,
      flags: {
        businessApproved: true,
        licenseVerified: false,
        resaleCertVerified: false,
        purchaseAgreementVerified: false,
        projectedVolumeApproved: false,
        firstOrderAt: null,
        now,
      },
      current: {
        calculatedTierId: "b",
        effectiveTierId: "b",
        pendingTierId: null,
        overrideTierId: null,
        overrideExpiresAt: null,
        overridePausesAutomation: false,
        gracePeriodEndsAt: null,
        nextReviewAt: null,
        historyStatus: "COMPLETE",
        protectFromIncompleteHistoryDowngrade: true,
      },
      policy: {
        ...DEFAULT_AUTOMATION_POLICY,
        downgradeMode: "grace_period",
        gracePeriodDays: 30,
      },
      now,
    });
    expect(decision.effectiveTierId).toBe("b");
    expect(decision.pendingTierId).toBe("a");
    expect(decision.changeType).toBe("GRACE_PERIOD");
    expect(decision.deferred).toBe(true);
  });

  it("honors manual overrides until expiry", () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const decision = decideAssignment({
      spendMinor: 0n,
      tiers,
      flags: {
        businessApproved: true,
        licenseVerified: false,
        resaleCertVerified: false,
        purchaseAgreementVerified: false,
        projectedVolumeApproved: false,
        firstOrderAt: null,
        now,
      },
      current: {
        calculatedTierId: "a",
        effectiveTierId: "b",
        pendingTierId: null,
        overrideTierId: "b",
        overrideExpiresAt: new Date("2026-12-01"),
        overridePausesAutomation: true,
        gracePeriodEndsAt: null,
        nextReviewAt: null,
        historyStatus: "COMPLETE",
        protectFromIncompleteHistoryDowngrade: true,
      },
      policy: DEFAULT_AUTOMATION_POLICY,
      now,
    });
    expect(decision.effectiveTierId).toBe("b");
    expect(decision.reason).toMatch(/override/i);
  });

  it("blocks auto-downgrade when history is insufficient", () => {
    const decision = decideAssignment({
      spendMinor: 0n,
      tiers,
      flags: {
        businessApproved: true,
        licenseVerified: false,
        resaleCertVerified: false,
        purchaseAgreementVerified: false,
        projectedVolumeApproved: false,
        firstOrderAt: null,
        now: new Date(),
      },
      current: {
        calculatedTierId: "b",
        effectiveTierId: "b",
        pendingTierId: null,
        overrideTierId: null,
        overrideExpiresAt: null,
        overridePausesAutomation: false,
        gracePeriodEndsAt: null,
        nextReviewAt: null,
        historyStatus: "INSUFFICIENT",
        protectFromIncompleteHistoryDowngrade: true,
      },
      policy: { ...DEFAULT_AUTOMATION_POLICY, downgradeMode: "immediate" },
      now: new Date(),
    });
    expect(decision.effectiveTierId).toBe("b");
    expect(decision.deferred).toBe(true);
    expect(decision.reason).toMatch(/Insufficient history/i);
  });
});

describe("spend calculation", () => {
  it("excludes cancelled/test and deducts refunds without double counting", () => {
    const now = new Date("2026-06-01T12:00:00Z");
    const result = calculateQualifyingSpend(
      [
        {
          processedAt: new Date("2026-01-15T12:00:00Z"),
          financialStatus: "paid",
          cancelledAt: null,
          test: false,
          currencyCode: "USD",
          merchandiseMinor: 10000n,
          refundedMerchandiseMinor: 2000n,
          qualifyingMinor: 8000n,
          salesChannel: "web",
          sourceName: "web",
          lines: [
            {
              merchandiseMinor: 10000n,
              isGiftCard: false,
              excluded: false,
              productId: null,
              collectionIds: [],
            },
          ],
        },
        {
          processedAt: new Date("2026-02-01T12:00:00Z"),
          financialStatus: "paid",
          cancelledAt: new Date("2026-02-02"),
          test: false,
          currencyCode: "USD",
          merchandiseMinor: 5000n,
          refundedMerchandiseMinor: 0n,
          qualifyingMinor: 5000n,
          salesChannel: "web",
          sourceName: "web",
          lines: [],
        },
      ],
      { ...DEFAULT_SPEND_POLICY, preferOrderAdjustedTotals: true },
      "USD",
      now,
      "UTC",
    );
    expect(result.qualifyingSpendMinor).toBe(8000n);
    expect(result.includedOrderCount).toBe(1);
  });

  it("does not mix presentment currencies into shop spend", () => {
    const result = calculateQualifyingSpend(
      [
        {
          processedAt: new Date(),
          financialStatus: "paid",
          cancelledAt: null,
          test: false,
          currencyCode: "EUR",
          merchandiseMinor: 10000n,
          refundedMerchandiseMinor: 0n,
          qualifyingMinor: 10000n,
          salesChannel: null,
          sourceName: null,
          lines: [],
        },
      ],
      DEFAULT_SPEND_POLICY,
      "USD",
      new Date(),
      "UTC",
    );
    expect(result.qualifyingSpendMinor).toBe(0n);
  });
});

describe("starter preset", () => {
  it("is optional and editable — not baked into engine enums", () => {
    const preset = hvacStarterPreset();
    expect(preset.map((p) => p.name)).toEqual(["Retail", "Tier C", "Tier B", "Tier A"]);
    expect(preset[0].isFallback).toBe(true);
    // Engine works with completely different names
    expect(preset.every((p) => typeof p.minSpend === "string")).toBe(true);
  });
});

/**
 * Tier assignment rules: calculated vs effective vs pending vs override.
 */

import type { AutomationPolicy } from "../../lib/policies";
import type { EligibilityFlags, QualificationResult, TierRecord } from "../eligibility/tier-engine";
import { qualifyCustomer } from "../eligibility/tier-engine";
import type { MoneyMinor } from "../../lib/money";

export type AssignmentState = {
  calculatedTierId: string | null;
  effectiveTierId: string | null;
  pendingTierId: string | null;
  overrideTierId: string | null;
  overrideExpiresAt: Date | null;
  overridePausesAutomation: boolean;
  gracePeriodEndsAt: Date | null;
  nextReviewAt: Date | null;
  historyStatus: "UNKNOWN" | "COMPLETE" | "INSUFFICIENT" | "PARTIAL";
  protectFromIncompleteHistoryDowngrade: boolean;
};

export type AssignmentDecision = {
  calculatedTierId: string | null;
  effectiveTierId: string | null;
  pendingTierId: string | null;
  gracePeriodEndsAt: Date | null;
  nextReviewAt: Date | null;
  changeType:
    | "CALCULATED"
    | "UPGRADE"
    | "DOWNGRADE"
    | "OVERRIDE_SET"
    | "OVERRIDE_EXPIRED"
    | "GRACE_PERIOD"
    | "REVIEW_SCHEDULED"
    | "FALLBACK"
    | null;
  reason: string;
  qualification: QualificationResult;
  deferred: boolean;
};

function tierRank(tiers: TierRecord[], tierId: string | null): bigint {
  if (!tierId) return -1n;
  const t = tiers.find((x) => x.id === tierId);
  return t ? BigInt(t.minSpendMinor) : -1n;
}

export function computeNextReviewAt(
  now: Date,
  policy: AutomationPolicy,
): Date | null {
  if (policy.reviewInterval === "none") return null;
  const months =
    policy.reviewInterval === "quarterly" ? 3 : policy.reviewInterval === "semi_annual" ? 6 : 12;
  const d = new Date(now);
  d.setUTCMonth(d.getUTCMonth() + months);
  const day = Math.min(Math.max(policy.reviewAnchorDay, 1), 28);
  d.setUTCDate(day);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Determine effective assignment given spend qualification and automation policy.
 * Spend is always recalculated; assignment changes may wait for review/grace.
 */
export function decideAssignment(args: {
  spendMinor: MoneyMinor;
  tiers: TierRecord[];
  flags: EligibilityFlags;
  current: AssignmentState;
  policy: AutomationPolicy;
  now: Date;
}): AssignmentDecision {
  const { spendMinor, tiers, flags, current, policy, now } = args;
  const qualification = qualifyCustomer(spendMinor, tiers, flags);
  const calculatedId = qualification.calculatedTier?.id ?? null;

  // Active manual override
  if (
    current.overrideTierId &&
    (!current.overrideExpiresAt || current.overrideExpiresAt > now)
  ) {
    return {
      calculatedTierId: calculatedId,
      effectiveTierId: current.overrideTierId,
      pendingTierId: calculatedId !== current.overrideTierId ? calculatedId : null,
      gracePeriodEndsAt: current.gracePeriodEndsAt,
      nextReviewAt: current.nextReviewAt,
      changeType: null,
      reason: "Manual override active",
      qualification,
      deferred: current.overridePausesAutomation,
    };
  }

  // Expired override → recalculate normally
  if (current.overrideTierId && current.overrideExpiresAt && current.overrideExpiresAt <= now) {
    // fall through with override cleared conceptually
  }

  if (policy.pauseAutomation) {
    return {
      calculatedTierId: calculatedId,
      effectiveTierId: current.effectiveTierId,
      pendingTierId: calculatedId,
      gracePeriodEndsAt: current.gracePeriodEndsAt,
      nextReviewAt: current.nextReviewAt,
      changeType: null,
      reason: "Automation paused",
      qualification,
      deferred: true,
    };
  }

  const currentEffective = current.effectiveTierId;
  if (calculatedId === currentEffective) {
    return {
      calculatedTierId: calculatedId,
      effectiveTierId: currentEffective,
      pendingTierId: null,
      gracePeriodEndsAt: null,
      nextReviewAt: current.nextReviewAt,
      changeType: null,
      reason: "No assignment change",
      qualification,
      deferred: false,
    };
  }

  const isUpgrade = tierRank(tiers, calculatedId) > tierRank(tiers, currentEffective);
  const isDowngrade = tierRank(tiers, calculatedId) < tierRank(tiers, currentEffective);

  // Incomplete history protection
  if (
    isDowngrade &&
    current.protectFromIncompleteHistoryDowngrade &&
    (current.historyStatus === "INSUFFICIENT" || current.historyStatus === "PARTIAL")
  ) {
    return {
      calculatedTierId: calculatedId,
      effectiveTierId: currentEffective,
      pendingTierId: calculatedId,
      gracePeriodEndsAt: current.gracePeriodEndsAt,
      nextReviewAt: current.nextReviewAt,
      changeType: null,
      reason: "Insufficient history — automatic downgrade blocked",
      qualification,
      deferred: true,
    };
  }

  if (isUpgrade) {
    if (policy.upgradeMode === "immediate") {
      return {
        calculatedTierId: calculatedId,
        effectiveTierId: calculatedId,
        pendingTierId: null,
        gracePeriodEndsAt: null,
        nextReviewAt: current.nextReviewAt,
        changeType: "UPGRADE",
        reason: `Immediate upgrade to ${qualification.calculatedTier?.name ?? "tier"}`,
        qualification,
        deferred: false,
      };
    }
    return {
      calculatedTierId: calculatedId,
      effectiveTierId: currentEffective,
      pendingTierId: calculatedId,
      gracePeriodEndsAt: current.gracePeriodEndsAt,
      nextReviewAt: current.nextReviewAt ?? computeNextReviewAt(now, policy),
      changeType: "REVIEW_SCHEDULED",
      reason: "Upgrade deferred until next scheduled review",
      qualification,
      deferred: true,
    };
  }

  if (isDowngrade) {
    if (policy.downgradeMode === "immediate") {
      return {
        calculatedTierId: calculatedId,
        effectiveTierId: calculatedId,
        pendingTierId: null,
        gracePeriodEndsAt: null,
        nextReviewAt: current.nextReviewAt,
        changeType: "DOWNGRADE",
        reason: `Immediate downgrade to ${qualification.calculatedTier?.name ?? "fallback"}`,
        qualification,
        deferred: false,
      };
    }
    if (policy.downgradeMode === "grace_period") {
      const graceEnd =
        current.gracePeriodEndsAt && current.gracePeriodEndsAt > now
          ? current.gracePeriodEndsAt
          : new Date(now.getTime() + policy.gracePeriodDays * 24 * 60 * 60 * 1000);
      if (graceEnd > now) {
        return {
          calculatedTierId: calculatedId,
          effectiveTierId: currentEffective,
          pendingTierId: calculatedId,
          gracePeriodEndsAt: graceEnd,
          nextReviewAt: current.nextReviewAt,
          changeType: "GRACE_PERIOD",
          reason: `Downgrade deferred — grace period until ${graceEnd.toISOString()}`,
          qualification,
          deferred: true,
        };
      }
      return {
        calculatedTierId: calculatedId,
        effectiveTierId: calculatedId,
        pendingTierId: null,
        gracePeriodEndsAt: null,
        nextReviewAt: current.nextReviewAt,
        changeType: "DOWNGRADE",
        reason: "Grace period ended — applying downgrade",
        qualification,
        deferred: false,
      };
    }
    // next_review
    if (current.nextReviewAt && current.nextReviewAt > now) {
      return {
        calculatedTierId: calculatedId,
        effectiveTierId: currentEffective,
        pendingTierId: calculatedId,
        gracePeriodEndsAt: current.gracePeriodEndsAt,
        nextReviewAt: current.nextReviewAt,
        changeType: "REVIEW_SCHEDULED",
        reason: "Downgrade deferred until scheduled review",
        qualification,
        deferred: true,
      };
    }
    return {
      calculatedTierId: calculatedId,
      effectiveTierId: calculatedId,
      pendingTierId: null,
      gracePeriodEndsAt: null,
      nextReviewAt: computeNextReviewAt(now, policy),
      changeType: "DOWNGRADE",
      reason: "Scheduled review due — applying downgrade",
      qualification,
      deferred: false,
    };
  }

  return {
    calculatedTierId: calculatedId,
    effectiveTierId: calculatedId,
    pendingTierId: null,
    gracePeriodEndsAt: null,
    nextReviewAt: current.nextReviewAt,
    changeType: "CALCULATED",
    reason: "Assignment recalculated",
    qualification,
    deferred: false,
  };
}

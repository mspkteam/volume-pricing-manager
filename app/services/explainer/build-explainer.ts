/**
 * Dynamic merchant-facing explainer copy from saved tiers / currency / policies.
 */

import { formatMoney, bpsToPercentString, type MoneyMinor } from "../../lib/money";
import { buildSpendRanges, type AutomationPolicy, type SpendPolicy } from "../../lib/policies";

export type ExplainerTier = {
  id: string;
  name: string;
  minSpendMinor: bigint | MoneyMinor;
  discountBps: number;
  requiresApproval: boolean;
  requiresLicense: boolean;
  isActive: boolean;
  isArchived: boolean;
  isFallback: boolean;
};

export type ChecklistProgress = {
  publishedForms?: number;
  pendingApplications?: number;
  importStatus?: string;
  reviewedApplications?: number;
};

export function buildExplainer(args: {
  displayName: string;
  currencyCode: string;
  timezone: string;
  spendPolicy: SpendPolicy;
  automationPolicy: AutomationPolicy;
  tiers: ExplainerTier[];
  pricingStatus: string;
  pricingProviderLabel: string;
  historyAccessLimited: boolean;
  progress?: ChecklistProgress;
}) {
  const {
    displayName,
    currencyCode,
    timezone,
    spendPolicy,
    automationPolicy,
    pricingStatus,
    pricingProviderLabel,
    historyAccessLimited,
    progress = {},
  } = args;

  const tiers = args.tiers.filter((t) => t.isActive && !t.isArchived);
  const money = (m: bigint | MoneyMinor) => formatMoney(BigInt(m), currencyCode);
  const ranges = buildSpendRanges(tiers);

  const exampleTier = [...tiers].sort((a, b) =>
    BigInt(a.minSpendMinor) < BigInt(b.minSpendMinor)
      ? -1
      : BigInt(a.minSpendMinor) > BigInt(b.minSpendMinor)
        ? 1
        : 0,
  );
  const mid = exampleTier[Math.min(1, exampleTier.length - 1)];

  const dynamicExample = mid
    ? `A customer with ${money(mid.minSpendMinor)} of qualifying purchases in the last ${spendPolicy.rollingPeriodMonths} months qualifies for ${mid.name}, subject to ${
        mid.requiresApproval
          ? "business approval" + (mid.requiresLicense ? " and license verification" : "")
          : "the eligibility rules configured for that tier"
      }. Their ${bpsToPercentString(mid.discountBps)}% discount applies through ${pricingProviderLabel} when pricing status is Synced (currently: ${pricingStatus}).`
    : `No tiers yet — create your first tier (any name you choose) on the Pricing Tiers page. ${displayName} will calculate spend ranges automatically from each tier’s minimum threshold.`;

  const importDone =
    progress.importStatus === "COMPLETE" ||
    progress.importStatus === "READY" ||
    progress.importStatus === "SYNCED";

  const checklist = [
    {
      id: "tiers",
      label: "Create pricing tiers",
      done: tiers.length > 0,
      href: "/app/tiers",
    },
    {
      id: "forms",
      label: "Publish an application form",
      done: (progress.publishedForms ?? 0) > 0,
      href: "/app/forms",
    },
    {
      id: "wholesale",
      label: "Confirm wholesale / lock settings",
      done: true,
      href: "/app/wholesale",
    },
    {
      id: "approvals",
      label:
        (progress.pendingApplications ?? 0) > 0
          ? `Review applications (${progress.pendingApplications} waiting)`
          : "Review applications",
      done:
        (progress.reviewedApplications ?? 0) > 0 ||
        ((progress.publishedForms ?? 0) > 0 && (progress.pendingApplications ?? 0) === 0),
      href: "/app/applications",
    },
    {
      id: "import",
      label: "Import purchase history",
      done: importDone,
      href: "/app/automation",
    },
    {
      id: "automation",
      label: "Turn on automation",
      done: !automationPolicy.pauseAutomation,
      href: "/app/automation",
    },
    {
      id: "simulate",
      label: "Try the tier simulator",
      done: false,
      href: "/app/simulator",
    },
    {
      id: "pricing",
      label: "Optional: sync checkout discounts",
      done: pricingStatus === "READY" || pricingStatus === "SYNCED",
      href: "/app/settings",
    },
  ];

  return {
    title: `How ${displayName} works`,
    dynamicExample,
    periodLabel: `${spendPolicy.rollingPeriodMonths} calendar months (${timezone})`,
    includeTax: spendPolicy.includeTax,
    includeShipping: spendPolicy.includeShipping,
    ranges: ranges.map((r) => ({
      name: r.name,
      label:
        r.maxSpendMinorExclusive == null
          ? `${money(r.minSpendMinor)} and above`
          : `${money(r.minSpendMinor)} up to (but not including) ${money(r.maxSpendMinorExclusive)}`,
      discount: `${bpsToPercentString(r.discountBps)}%`,
    })),
    upgradeMode: automationPolicy.upgradeMode,
    downgradeMode: automationPolicy.downgradeMode,
    gracePeriodDays: automationPolicy.gracePeriodDays,
    reviewInterval: automationPolicy.reviewInterval,
    pricingStatus,
    pricingProviderLabel,
    historyAccessLimited,
    checklist,
    plannedCapabilities: [
      "Tier-specific pack sizes and MOQs (requires checkout validation — not storefront messaging alone)",
      "Product-specific quantity rules",
      "Net payment terms after qualifying order counts (Shopify payment terms integration required)",
      "Annual rebates",
      "Freight allowances",
      "Priority fulfillment",
    ],
    sections: [
      {
        heading: "What the app does",
        body: `${displayName} tracks each customer’s qualifying purchases, assigns the best eligible pricing tier you configured, and syncs that tier to checkout pricing when the pricing provider is set up.`,
      },
      {
        heading: "Creating and naming tiers",
        body: `You choose every tier name — Bronze, Trade Partner, Distributor, or anything else. Renaming keeps the same internal ID, so assignments and history stay intact. ${
          tiers.length ? `You currently have ${tiers.length} active tier(s).` : "Start empty or apply the optional starter preset."
        }`,
      },
      {
        heading: "What counts toward qualifying spend",
        body: `Default: paid merchandise after discounts in ${currencyCode}. Tax ${spendPolicy.includeTax ? "is" : "is not"} included. Shipping ${spendPolicy.includeShipping ? "is" : "is not"} included. Gift cards, cancelled, and test orders are excluded by default. Refunded merchandise is deducted.`,
      },
      {
        heading: "Rolling period",
        body: `Spend is totaled over the last ${spendPolicy.rollingPeriodMonths} calendar months using ${timezone} for day boundaries. Month-end dates clamp safely (including leap years). When old purchases age out of the window, a customer can be downgraded even without a new order.`,
      },
      {
        heading: "Business approval",
        body: "If a tier requires approval (or license / resale / agreement checks), high spend alone is not enough. The app evaluates the next lower eligible tier instead.",
      },
      {
        heading: "Upgrades",
        body: `Upgrade mode is set to “${automationPolicy.upgradeMode}”. Immediate upgrades apply as soon as spend and eligibility qualify after an eligible payment is processed.`,
      },
      {
        heading: "Downgrades without new purchases",
        body: "The scheduler recalculates daily. When purchases leave the rolling window, calculated spend can drop and trigger a downgrade according to your policy.",
      },
      {
        heading: "Grace periods and reviews",
        body: `Downgrade mode: ${automationPolicy.downgradeMode}. Grace period: ${automationPolicy.gracePeriodDays} days. Review interval: ${automationPolicy.reviewInterval}. Spend still recalculates while assignment changes wait.`,
      },
      {
        heading: "Manual overrides",
        body: "Overrides set an effective tier with a reason, optional expiry, and optional pause of automated reassignment. When an override expires, normal calculation resumes.",
      },
      {
        heading: "How pricing reaches checkout",
        body: `Configured provider: ${pricingProviderLabel}. Percentage discounts use the Shopify selling price (not compare-at/MSRP unless you later configure an explicit MSRP source).`,
      },
      {
        heading: "Tier status vs pricing status",
        body: `Assignment and checkout sync are separate. Pricing status is currently “${pricingStatus}”. A customer can be in a tier while checkout discounts are still Setup required.`,
      },
      {
        heading: "Historical access limits",
        body: historyAccessLimited
          ? "This shop’s imported history is limited. Insufficient history is shown openly, and automatic downgrades from incomplete data are blocked by default."
          : "When read_all_orders (and approval) is available, the app can cover the full rolling window. Until then, treat coverage indicators as authoritative.",
      },
      {
        heading: "Troubleshooting",
        body: "Check Automation for failed jobs, Activity for assignment and sync errors, and Settings for pricing compatibility. Re-run customer recalculation or pricing sync from the customer detail page.",
      },
    ],
  };
}

/**
 * Clay-like wholesale access policy — tags + lock rules owned by this app.
 */

export type WholesaleLockMode =
  | "off"
  | "login_required"
  | "approved_only"
  | "tier_tagged";

export type WholesaleAccessPolicy = {
  /** Sync Shopify customer tags from effective tier + approval */
  syncCustomerTags: boolean;
  /** Prefix for managed tags (tier name is also applied as a plain tag for Clay-compat themes) */
  managedTagPrefix: string;
  /** Tag applied when businessApproved is true */
  approvedTag: string;
  /** Also write vpm-pct-{n} so themes can read discount without hardcoding 30/20/10 */
  writePercentTag: boolean;
  /** Storefront lock behavior for prices / ATC */
  lockMode: WholesaleLockMode;
  /** Message when prices are locked */
  lockMessage: string;
  /** Login message for guests */
  loginMessage: string;
};

export const DEFAULT_WHOLESALE_ACCESS_POLICY: WholesaleAccessPolicy = {
  syncCustomerTags: true,
  managedTagPrefix: "vpm",
  approvedTag: "vpm-approved",
  writePercentTag: true,
  lockMode: "approved_only",
  lockMessage:
    "Wholesale pricing is available to approved customers only. Apply for an account or contact us if you need access.",
  loginMessage: "Please log in to view wholesale pricing. If you don't have an account, apply for wholesale access.",
};

export function parseWholesaleAccessPolicy(raw: unknown): WholesaleAccessPolicy {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<WholesaleAccessPolicy>;
  return {
    ...DEFAULT_WHOLESALE_ACCESS_POLICY,
    ...o,
    syncCustomerTags: o.syncCustomerTags ?? DEFAULT_WHOLESALE_ACCESS_POLICY.syncCustomerTags,
    managedTagPrefix: o.managedTagPrefix || DEFAULT_WHOLESALE_ACCESS_POLICY.managedTagPrefix,
    approvedTag: o.approvedTag || DEFAULT_WHOLESALE_ACCESS_POLICY.approvedTag,
    writePercentTag: o.writePercentTag ?? DEFAULT_WHOLESALE_ACCESS_POLICY.writePercentTag,
    lockMode: o.lockMode || DEFAULT_WHOLESALE_ACCESS_POLICY.lockMode,
    lockMessage: o.lockMessage || DEFAULT_WHOLESALE_ACCESS_POLICY.lockMessage,
    loginMessage: o.loginMessage || DEFAULT_WHOLESALE_ACCESS_POLICY.loginMessage,
  };
}

/** Build the set of tags this app owns for a customer state. */
export function buildWholesaleTags(args: {
  policy: WholesaleAccessPolicy;
  businessApproved: boolean;
  tierName: string | null;
  discountBps: number;
}): { desired: string[]; managedPrefixes: string[] } {
  const desired: string[] = [];
  const prefix = args.policy.managedTagPrefix;

  desired.push(prefix);

  if (args.businessApproved) {
    desired.push(args.policy.approvedTag);
  }

  if (args.tierName) {
    // Clay-compatible plain tag (Wholesale / Distributor / Retailer, etc.)
    desired.push(args.tierName);
    desired.push(`${prefix}-tier-${slugTag(args.tierName)}`);
  }

  if (args.policy.writePercentTag && args.discountBps > 0) {
    const pct = Math.round(args.discountBps / 100);
    desired.push(`${prefix}-pct-${pct}`);
  }

  return {
    desired: unique(desired),
    managedPrefixes: [prefix, args.policy.approvedTag],
  };
}

function slugTag(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function unique(arr: string[]): string[] {
  return [...new Set(arr.map((t) => t.trim()).filter(Boolean))];
}

/**
 * Decide which existing customer tags to remove (only ones we manage).
 * Preserves unrelated merchant/Clay tags that aren't our managed set.
 */
export function diffWholesaleTags(args: {
  existingTags: string[];
  desired: string[];
  policy: WholesaleAccessPolicy;
  knownTierNames: string[];
}): { toAdd: string[]; toRemove: string[] } {
  const existing = args.existingTags.map((t) => t.trim()).filter(Boolean);
  const desiredLower = new Set(args.desired.map((t) => t.toLowerCase()));
  const knownTier = new Set(args.knownTierNames.map((t) => t.toLowerCase()));
  const prefix = args.policy.managedTagPrefix.toLowerCase();
  const approved = args.policy.approvedTag.toLowerCase();

  const isManaged = (tag: string) => {
    const t = tag.toLowerCase();
    if (t === prefix || t === approved) return true;
    if (t.startsWith(`${prefix}-`)) return true;
    if (knownTier.has(t)) return true;
    return false;
  };

  const toRemove = existing.filter((tag) => isManaged(tag) && !desiredLower.has(tag.toLowerCase()));
  const existingLower = new Set(existing.map((t) => t.toLowerCase()));
  const toAdd = args.desired.filter((tag) => !existingLower.has(tag.toLowerCase()));

  return { toAdd, toRemove };
}

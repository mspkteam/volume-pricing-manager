/**
 * Sync each unique tier % to a Shopify automatic basic discount
 * scoped to customers tagged vpm-pct-{n} (same tags the theme already uses).
 *
 * This is the checkout path that does NOT need Discount Functions / Plus.
 */

import type { PrismaClient } from "@prisma/client";
import { writeAuditLog } from "../audit/audit-log";

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export type TierDiscountRef = {
  tierIds: string[];
  percent: number;
  discountBps: number;
  segmentId: string | null;
  discountGid: string | null;
  title: string;
};

export type AutomaticBasicSyncResult = {
  ok: boolean;
  message: string;
  refs: TierDiscountRef[];
  errors: string[];
};

type StoredMap = Record<
  string,
  { segmentId?: string; discountGid?: string; percent?: number; title?: string }
>;

function percentFromBps(bps: number): number {
  return Math.round(bps / 100);
}

function discountTitle(percent: number): string {
  return `VPM ${percent}% wholesale`;
}

function segmentName(percent: number): string {
  return `VPM customers ${percent}% (vpm-pct-${percent})`;
}

function segmentQuery(percent: number): string {
  // Shopify customer segment query language
  return `customer_tags CONTAINS 'vpm-pct-${percent}'`;
}

async function gql(
  admin: AdminGraphql,
  query: string,
  variables?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = await admin.graphql(query, variables ? { variables } : undefined);
  return (await res.json()) as Record<string, unknown>;
}

async function findSegmentByName(
  admin: AdminGraphql,
  name: string,
): Promise<string | null> {
  const json = await gql(
    admin,
    `#graphql
    query VpmListSegments {
      segments(first: 100) {
        nodes { id name }
      }
    }`,
  );
  const nodes = (json?.data as { segments?: { nodes?: Array<{ id: string; name: string }> } })
    ?.segments?.nodes;
  return nodes?.find((n) => n.name === name)?.id ?? null;
}

async function createSegment(
  admin: AdminGraphql,
  name: string,
  query: string,
): Promise<{ id: string | null; error: string | null }> {
  const existing = await findSegmentByName(admin, name);
  if (existing) return { id: existing, error: null };

  const json = await gql(
    admin,
    `#graphql
    mutation VpmSegmentCreate($name: String!, $query: String!) {
      segmentCreate(name: $name, query: $query) {
        segment { id name }
        userErrors { message }
      }
    }`,
    { name, query },
  );
  const payload = (json?.data as { segmentCreate?: {
    segment?: { id: string };
    userErrors?: Array<{ message: string }>;
  } })?.segmentCreate;
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    // Race / already exists — try lookup again
    const again = await findSegmentByName(admin, name);
    if (again) return { id: again, error: null };
    return { id: null, error: errors.map((e) => e.message).join("; ") };
  }
  return { id: payload?.segment?.id ?? null, error: null };
}

async function createOrUpdateAutomaticDiscount(
  admin: AdminGraphql,
  args: {
    existingGid: string | null;
    title: string;
    percent: number;
    segmentId: string;
  },
): Promise<{ discountGid: string | null; error: string | null }> {
  const percentage = args.percent / 100; // Shopify expects 0.15 for 15%
  const startsAt = new Date().toISOString();
  const input = {
    title: args.title,
    startsAt,
    combinesWith: {
      orderDiscounts: true,
      productDiscounts: true,
      shippingDiscounts: true,
    },
    customerGets: {
      value: { percentage },
      items: { all: true },
    },
    context: {
      customerSegments: {
        add: [args.segmentId],
      },
    },
  };

  if (args.existingGid) {
    const json = await gql(
      admin,
      `#graphql
      mutation VpmDiscountBasicUpdate($id: ID!, $automaticBasicDiscount: DiscountAutomaticBasicInput!) {
        discountAutomaticBasicUpdate(id: $id, automaticBasicDiscount: $automaticBasicDiscount) {
          automaticDiscountNode { id }
          userErrors { field message }
        }
      }`,
      {
        id: args.existingGid,
        automaticBasicDiscount: {
          title: input.title,
          customerGets: input.customerGets,
          combinesWith: input.combinesWith,
          context: {
            customerSegments: {
              add: [args.segmentId],
            },
          },
        },
      },
    );
    const payload = (json?.data as {
      discountAutomaticBasicUpdate?: {
        automaticDiscountNode?: { id: string };
        userErrors?: Array<{ message: string }>;
      };
    })?.discountAutomaticBasicUpdate;
    const errors = payload?.userErrors ?? [];
    if (errors.length) {
      // Stale GID — fall through to create
      const msg = errors.map((e) => e.message).join("; ");
      if (!/not found|invalid|deleted/i.test(msg)) {
        return { discountGid: null, error: msg };
      }
    } else {
      return {
        discountGid: payload?.automaticDiscountNode?.id ?? args.existingGid,
        error: null,
      };
    }
  }

  const json = await gql(
    admin,
    `#graphql
    mutation VpmDiscountBasicCreate($automaticBasicDiscount: DiscountAutomaticBasicInput!) {
      discountAutomaticBasicCreate(automaticBasicDiscount: $automaticBasicDiscount) {
        automaticDiscountNode { id }
        userErrors { field message }
      }
    }`,
    { automaticBasicDiscount: input },
  );
  const payload = (json?.data as {
    discountAutomaticBasicCreate?: {
      automaticDiscountNode?: { id: string };
      userErrors?: Array<{ message: string }>;
    };
  })?.discountAutomaticBasicCreate;
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    return { discountGid: null, error: errors.map((e) => e.message).join("; ") };
  }
  return {
    discountGid: payload?.automaticDiscountNode?.id ?? null,
    error: null,
  };
}

/**
 * Ensure one automatic % discount exists per unique active tier discount %.
 * Customers with tag vpm-pct-{n} get n% off at checkout automatically (no code).
 */
export async function syncTierToAutomaticDiscounts(
  prisma: PrismaClient,
  admin: AdminGraphql,
  args: {
    shopId: string;
    shopDomain: string;
    actor?: string;
  },
): Promise<AutomaticBasicSyncResult> {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: args.shopId } });
  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: args.shopId, isActive: true, isArchived: false },
    orderBy: { displayOrder: "asc" },
  });

  const byPercent = new Map<number, { discountBps: number; tierIds: string[] }>();
  for (const t of tiers) {
    if (t.discountBps <= 0) continue;
    const percent = percentFromBps(t.discountBps);
    if (percent <= 0 || percent > 100) continue;
    const row = byPercent.get(percent) || { discountBps: t.discountBps, tierIds: [] };
    row.tierIds.push(t.id);
    row.discountBps = t.discountBps;
    byPercent.set(percent, row);
  }

  if (!byPercent.size) {
    return {
      ok: false,
      message: "No active tiers with a discount % to sync.",
      refs: [],
      errors: [],
    };
  }

  const external = {
    ...((shop.pricingExternalIds as Record<string, unknown>) || {}),
  };
  const stored = ((external.automaticDiscounts as StoredMap) || {}) as StoredMap;
  const nextMap: StoredMap = { ...stored };
  const refs: TierDiscountRef[] = [];
  const errors: string[] = [];

  for (const [percent, group] of byPercent) {
    const key = String(percent);
    const title = discountTitle(percent);
    const prev = stored[key] || {};

    const seg = await createSegment(admin, segmentName(percent), segmentQuery(percent));
    if (!seg.id) {
      errors.push(`${percent}%: segment — ${seg.error || "failed"}`);
      refs.push({
        tierIds: group.tierIds,
        percent,
        discountBps: group.discountBps,
        segmentId: null,
        discountGid: prev.discountGid || null,
        title,
      });
      continue;
    }

    const disc = await createOrUpdateAutomaticDiscount(admin, {
      existingGid: prev.discountGid || null,
      title,
      percent,
      segmentId: seg.id,
    });
    if (!disc.discountGid) {
      errors.push(`${percent}%: discount — ${disc.error || "failed"}`);
      refs.push({
        tierIds: group.tierIds,
        percent,
        discountBps: group.discountBps,
        segmentId: seg.id,
        discountGid: null,
        title,
      });
      continue;
    }

    nextMap[key] = {
      segmentId: seg.id,
      discountGid: disc.discountGid,
      percent,
      title,
    };
    refs.push({
      tierIds: group.tierIds,
      percent,
      discountBps: group.discountBps,
      segmentId: seg.id,
      discountGid: disc.discountGid,
      title,
    });
  }

  // Drop stored entries for percents no longer used by active tiers
  for (const key of Object.keys(nextMap)) {
    if (!byPercent.has(Number(key))) {
      delete nextMap[key];
    }
  }

  const ok = errors.length === 0 && refs.every((r) => r.discountGid);
  const message = ok
    ? `Checkout automatic discounts synced for ${refs.length} tier rate(s): ${refs
        .map((r) => `${r.percent}%`)
        .join(", ")}. Approved buyers with matching vpm-pct-* tags get the discount at checkout (no code).`
    : `Partial sync: ${refs.filter((r) => r.discountGid).length}/${refs.length} discounts ready. ${errors.join(" · ")}`;

  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      pricingProvider: "automatic_basic",
      pricingStatus: ok ? "SYNCED" : errors.length && refs.some((r) => r.discountGid) ? "READY" : "FAILED",
      pricingCompatibility: ok || refs.some((r) => r.discountGid) ? "SUPPORTED" : "SETUP_REQUIRED",
      pricingCompatibilityNote: message,
      settingsVersion: { increment: 1 },
      pricingExternalIds: {
        ...external,
        checkoutMode: "automatic_basic",
        checkoutWritesEnabled: true,
        automaticDiscounts: nextMap,
        activatedAt: new Date().toISOString(),
      },
    },
  });

  await writeAuditLog(prisma, {
    shopId: args.shopId,
    actor: args.actor ?? "system",
    action: "pricing.sync_automatic_basic",
    entityType: "Shop",
    entityId: args.shopId,
    summary: message,
    metadata: { refs, errors },
  });

  return { ok, message, refs, errors };
}

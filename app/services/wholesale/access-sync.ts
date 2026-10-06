/**
 * Sync Shopify customer tags so the storefront behaves like Clay B2B:
 * approved buyers get tier tags + percent tags; theme shows prices / unlocks catalog.
 */

import type { PrismaClient } from "@prisma/client";
import {
  buildWholesaleTags,
  diffWholesaleTags,
  parseWholesaleAccessPolicy,
  type WholesaleAccessPolicy,
} from "./policy";
import { writeAuditLog } from "../audit/audit-log";

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

export async function syncCustomerWholesaleAccess(
  prisma: PrismaClient,
  admin: AdminGraphql | null,
  args: {
    shopId: string;
    shopDomain: string;
    customerProfileId: string;
    actor?: string;
  },
): Promise<{ ok: boolean; message: string; toAdd?: string[]; toRemove?: string[] }> {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: args.shopId } });
  const policy = parseWholesaleAccessPolicy(
    (shop.notificationPrefs as Record<string, unknown>)?.wholesaleAccess ??
      (shop as { wholesaleAccessPolicy?: unknown }).wholesaleAccessPolicy,
  );

  // Prefer dedicated column when present (after migration); fall back to notificationPrefs
  const stored =
    "wholesaleAccessPolicy" in shop && (shop as { wholesaleAccessPolicy?: unknown }).wholesaleAccessPolicy != null
      ? parseWholesaleAccessPolicy((shop as { wholesaleAccessPolicy?: unknown }).wholesaleAccessPolicy)
      : policy;

  if (!stored.syncCustomerTags) {
    return { ok: true, message: "Tag sync disabled in wholesale access policy." };
  }

  const customer = await prisma.customerProfiles.findFirst({
    where: { id: args.customerProfileId, shopId: args.shopId },
    include: { effectiveTier: true },
  });
  if (!customer) return { ok: false, message: "Customer not found" };

  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: args.shopId, isArchived: false },
    select: { name: true },
  });

  const { desired } = buildWholesaleTags({
    policy: stored,
    businessApproved: customer.businessApproved,
    tierName: customer.effectiveTier?.name ?? null,
    discountBps: customer.effectiveTier?.discountBps ?? 0,
  });

  if (!admin) {
    return {
      ok: true,
      message: "Tag sync prepared (no Admin API client — skipped Shopify write).",
      toAdd: desired,
    };
  }

  const customerGid = customer.shopifyCustomerId.startsWith("gid://")
    ? customer.shopifyCustomerId
    : `gid://shopify/Customer/${customer.shopifyCustomerId}`;

  const existing = await fetchCustomerTags(admin, customerGid);
  const { toAdd, toRemove } = diffWholesaleTags({
    existingTags: existing,
    desired,
    policy: stored,
    knownTierNames: tiers.map((t) => t.name),
  });

  if (toRemove.length) {
    await tagsRemove(admin, customerGid, toRemove);
  }
  if (toAdd.length) {
    await tagsAdd(admin, customerGid, toAdd);
  }

  await writeAuditLog(prisma, {
    shopId: args.shopId,
    actor: args.actor ?? "system",
    action: "wholesale.tags_synced",
    entityType: "CustomerProfile",
    entityId: customer.id,
    summary: `Synced wholesale tags (+${toAdd.length}/-${toRemove.length})`,
    metadata: { toAdd, toRemove, desired },
  });

  return {
    ok: true,
    message: `Tags synced (+${toAdd.length}/-${toRemove.length})`,
    toAdd,
    toRemove,
  };
}

async function fetchCustomerTags(admin: AdminGraphql, customerGid: string): Promise<string[]> {
  const res = await admin.graphql(
    `#graphql
    query VpmCustomerTags($id: ID!) {
      customer(id: $id) { tags }
    }`,
    { variables: { id: customerGid } },
  );
  const json = await res.json();
  return (json?.data?.customer?.tags as string[]) ?? [];
}

async function tagsAdd(admin: AdminGraphql, customerGid: string, tags: string[]) {
  const res = await admin.graphql(
    `#graphql
    mutation VpmTagsAdd($id: ID!, $tags: [String!]!) {
      tagsAdd(id: $id, tags: $tags) {
        userErrors { message }
      }
    }`,
    { variables: { id: customerGid, tags } },
  );
  const json = await res.json();
  const errors = json?.data?.tagsAdd?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e: { message: string }) => e.message).join("; "));
}

async function tagsRemove(admin: AdminGraphql, customerGid: string, tags: string[]) {
  const res = await admin.graphql(
    `#graphql
    mutation VpmTagsRemove($id: ID!, $tags: [String!]!) {
      tagsRemove(id: $id, tags: $tags) {
        userErrors { message }
      }
    }`,
    { variables: { id: customerGid, tags } },
  );
  const json = await res.json();
  const errors = json?.data?.tagsRemove?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e: { message: string }) => e.message).join("; "));
}

export function getShopWholesalePolicy(shop: {
  notificationPrefs?: unknown;
  wholesaleAccessPolicy?: unknown;
}): WholesaleAccessPolicy {
  if (shop.wholesaleAccessPolicy != null) {
    return parseWholesaleAccessPolicy(shop.wholesaleAccessPolicy);
  }
  const prefs = (shop.notificationPrefs || {}) as Record<string, unknown>;
  return parseWholesaleAccessPolicy(prefs.wholesaleAccess);
}

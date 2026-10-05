/**
 * Normalize Shopify order payloads into shop-currency persisted records.
 */

import type { PrismaClient } from "@prisma/client";
import { createHash } from "node:crypto";
import { toMinorUnits, clampNonNegative, subMinor, type MoneyMinor } from "../../lib/money";
import { parseSpendPolicy } from "../shop/shop-service";

export type ShopifyOrderLike = {
  admin_graphql_api_id?: string;
  id?: number | string;
  name?: string;
  customer?: { admin_graphql_api_id?: string; id?: number | string } | null;
  processed_at?: string;
  created_at?: string;
  financial_status?: string;
  fulfillment_status?: string | null;
  cancelled_at?: string | null;
  test?: boolean;
  currency?: string;
  presentment_currency?: string;
  current_subtotal_price?: string;
  subtotal_price?: string;
  total_discounts?: string;
  total_tax?: string;
  total_shipping_price_set?: { shop_money?: { amount?: string } };
  source_name?: string;
  line_items?: Array<{
    admin_graphql_api_id?: string;
    id?: number | string;
    product_id?: number | string | null;
    variant_id?: number | string | null;
    sku?: string | null;
    title?: string;
    quantity?: number;
    price?: string;
    total_discount?: string;
    gift_card?: boolean;
    requires_shipping?: boolean;
  }>;
  refunds?: Array<{
    admin_graphql_api_id?: string;
    id?: number | string;
    processed_at?: string;
    created_at?: string;
    refund_line_items?: Array<{
      quantity?: number;
      subtotal?: string;
      line_item?: { price?: string };
    }>;
  }>;
};

function orderGid(order: ShopifyOrderLike): string {
  if (order.admin_graphql_api_id) return order.admin_graphql_api_id;
  return `gid://shopify/Order/${order.id}`;
}

function customerGid(order: ShopifyOrderLike): string | null {
  const c = order.customer;
  if (!c) return null;
  if (c.admin_graphql_api_id) return c.admin_graphql_api_id;
  if (c.id) return `gid://shopify/Customer/${c.id}`;
  return null;
}

function lineGid(line: NonNullable<ShopifyOrderLike["line_items"]>[number]): string {
  if (line.admin_graphql_api_id) return line.admin_graphql_api_id;
  return `gid://shopify/LineItem/${line.id}`;
}

function checksum(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

/**
 * Persist canonical order state. Qualifying amount uses shop currency only.
 */
export async function upsertNormalizedOrder(
  prisma: PrismaClient,
  shopId: string,
  shopCurrencyCode: string,
  order: ShopifyOrderLike,
) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const policy = parseSpendPolicy(shop.spendPolicy);
  const shopifyOrderId = orderGid(order);
  const shopifyCustomerId = customerGid(order);
  const currency = order.currency || shopCurrencyCode;

  if (currency !== shopCurrencyCode) {
    // Store with zero qualifying — do not convert presentment currencies
  }

  let merchandiseMinor: MoneyMinor = 0n;
  const lineRows = (order.line_items ?? []).map((line) => {
    const qty = line.quantity ?? 0;
    const price = toMinorUnits(line.price ?? "0");
    const discount = toMinorUnits(line.total_discount ?? "0");
    const lineMerch = clampNonNegative(subMinor(price * BigInt(qty), discount));
    merchandiseMinor += lineMerch;
    return {
      shopifyLineId: lineGid(line),
      productId: line.product_id ? `gid://shopify/Product/${line.product_id}` : null,
      variantId: line.variant_id ? `gid://shopify/ProductVariant/${line.variant_id}` : null,
      sku: line.sku ?? null,
      title: line.title ?? null,
      quantity: qty,
      merchandiseMinor: lineMerch,
      isGiftCard: Boolean(line.gift_card),
      excluded: false,
      collectionIds: [] as string[],
    };
  });

  // Prefer current_subtotal when present (already reflects edits/refunds)
  const currentSubtotal = order.current_subtotal_price ?? order.subtotal_price;
  let qualifyingMinor = merchandiseMinor;
  if (currentSubtotal != null && policy.preferOrderAdjustedTotals) {
    qualifyingMinor = toMinorUnits(currentSubtotal);
  }

  let refundedMerchandiseMinor: MoneyMinor = 0n;
  const refundRows = (order.refunds ?? []).map((refund) => {
    let refundMerch: MoneyMinor = 0n;
    for (const rli of refund.refund_line_items ?? []) {
      if (rli.subtotal != null) {
        refundMerch += toMinorUnits(rli.subtotal);
      } else if (rli.line_item?.price && rli.quantity) {
        refundMerch += toMinorUnits(rli.line_item.price) * BigInt(rli.quantity);
      }
    }
    refundedMerchandiseMinor += refundMerch;
    return {
      shopifyRefundId: refund.admin_graphql_api_id ?? `gid://shopify/Refund/${refund.id}`,
      processedAt: new Date(refund.processed_at ?? refund.created_at ?? Date.now()),
      merchandiseMinor: refundMerch,
      alreadyReflectedInOrder: Boolean(order.current_subtotal_price),
    };
  });

  if (!policy.preferOrderAdjustedTotals || order.current_subtotal_price == null) {
    qualifyingMinor = clampNonNegative(subMinor(merchandiseMinor, refundedMerchandiseMinor));
  }

  if (currency !== shopCurrencyCode) {
    qualifyingMinor = 0n;
  }

  // Exclude gift cards from qualifying when policy says so (recompute from lines)
  if (policy.excludeGiftCards && lineRows.some((l) => l.isGiftCard)) {
    const nonGift = lineRows
      .filter((l) => !l.isGiftCard)
      .reduce((acc, l) => acc + l.merchandiseMinor, 0n);
    if (!order.current_subtotal_price) {
      qualifyingMinor = clampNonNegative(subMinor(nonGift, refundedMerchandiseMinor));
    }
  }

  let customerProfileId: string | null = null;
  if (shopifyCustomerId) {
    const profile = await prisma.customerProfiles.upsert({
      where: {
        shopId_shopifyCustomerId: { shopId, shopifyCustomerId },
      },
      create: {
        shopId,
        shopifyCustomerId,
        firstOrderAt: new Date(order.processed_at ?? order.created_at ?? Date.now()),
      },
      update: {},
    });
    customerProfileId = profile.id;
    if (!profile.firstOrderAt) {
      await prisma.customerProfiles.update({
        where: { id: profile.id },
        data: {
          firstOrderAt: new Date(order.processed_at ?? order.created_at ?? Date.now()),
        },
      });
    }
  }

  const processedAt = new Date(order.processed_at ?? order.created_at ?? Date.now());

  const saved = await prisma.normalizedOrders.upsert({
    where: { shopId_shopifyOrderId: { shopId, shopifyOrderId } },
    create: {
      shopId,
      customerProfileId,
      shopifyOrderId,
      shopifyCustomerId,
      name: order.name ?? null,
      processedAt,
      financialStatus: order.financial_status ?? "pending",
      fulfillmentStatus: order.fulfillment_status ?? null,
      cancelledAt: order.cancelled_at ? new Date(order.cancelled_at) : null,
      test: Boolean(order.test),
      currencyCode: currency,
      merchandiseMinor,
      discountMinor: toMinorUnits(order.total_discounts ?? "0"),
      taxMinor: toMinorUnits(order.total_tax ?? "0"),
      shippingMinor: toMinorUnits(order.total_shipping_price_set?.shop_money?.amount ?? "0"),
      refundedMerchandiseMinor,
      qualifyingMinor,
      salesChannel: order.source_name ?? null,
      sourceName: order.source_name ?? null,
      rawChecksum: checksum(order),
      lines: { create: lineRows },
      refunds: { create: refundRows },
    },
    update: {
      customerProfileId,
      shopifyCustomerId,
      name: order.name ?? null,
      processedAt,
      financialStatus: order.financial_status ?? "pending",
      fulfillmentStatus: order.fulfillment_status ?? null,
      cancelledAt: order.cancelled_at ? new Date(order.cancelled_at) : null,
      test: Boolean(order.test),
      currencyCode: currency,
      merchandiseMinor,
      discountMinor: toMinorUnits(order.total_discounts ?? "0"),
      taxMinor: toMinorUnits(order.total_tax ?? "0"),
      shippingMinor: toMinorUnits(order.total_shipping_price_set?.shop_money?.amount ?? "0"),
      refundedMerchandiseMinor,
      qualifyingMinor,
      salesChannel: order.source_name ?? null,
      sourceName: order.source_name ?? null,
      rawChecksum: checksum(order),
      lastSyncedAt: new Date(),
    },
  });

  // Replace lines/refunds on update for canonical state
  await prisma.normalizedOrderLines.deleteMany({ where: { orderId: saved.id } });
  if (lineRows.length) {
    await prisma.normalizedOrderLines.createMany({
      data: lineRows.map((l) => ({ ...l, orderId: saved.id })),
    });
  }
  await prisma.normalizedRefunds.deleteMany({ where: { orderId: saved.id } });
  if (refundRows.length) {
    await prisma.normalizedRefunds.createMany({
      data: refundRows.map((r) => ({ ...r, orderId: saved.id })),
    });
  }

  return saved;
}

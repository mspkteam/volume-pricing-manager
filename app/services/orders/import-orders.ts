/**
 * Historical customer/order import via Admin GraphQL pagination.
 * Marks history as INSUFFICIENT when read_all_orders coverage is limited.
 */

import type { PrismaClient } from "@prisma/client";
import { upsertNormalizedOrder, type ShopifyOrderLike } from "./normalize-order";
import { writeAuditLog } from "../audit/audit-log";

type AdminGraphql = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

const ORDERS_QUERY = `#graphql
  query VolumePricingOrders($cursor: String) {
    orders(first: 50, after: $cursor, sortKey: PROCESSED_AT, reverse: true) {
      pageInfo { hasNextPage endCursor }
      edges {
        node {
          id
          name
          processedAt
          createdAt
          displayFinancialStatus
          displayFulfillmentStatus
          cancelledAt
          test
          currencyCode
          currentSubtotalPriceSet { shopMoney { amount currencyCode } }
          totalDiscountsSet { shopMoney { amount } }
          totalTaxSet { shopMoney { amount } }
          totalShippingPriceSet { shopMoney { amount } }
          customer { id email firstName lastName }
          lineItems(first: 100) {
            edges {
              node {
                id
                sku
                title
                quantity
                discountedTotalSet { shopMoney { amount } }
                product { id isGiftCard productType }
                variant { id }
              }
            }
          }
          refunds {
            id
            createdAt
            refundLineItems(first: 50) {
              edges {
                node {
                  quantity
                  subtotalSet { shopMoney { amount } }
                }
              }
            }
          }
        }
      }
    }
  }`;

function mapOrderNode(node: Record<string, unknown>): ShopifyOrderLike {
  const customer = node.customer as
    | { id?: string; email?: string; firstName?: string; lastName?: string }
    | null
    | undefined;
  const lineEdges =
    ((node.lineItems as { edges?: Array<{ node: Record<string, unknown> }> })?.edges) ?? [];
  const refunds = (node.refunds as Array<Record<string, unknown>>) ?? [];

  return {
    admin_graphql_api_id: String(node.id),
    name: String(node.name ?? ""),
    customer: customer
      ? { admin_graphql_api_id: customer.id, id: customer.id }
      : null,
    processed_at: String(node.processedAt ?? node.createdAt),
    created_at: String(node.createdAt),
    financial_status: String(node.displayFinancialStatus ?? "PENDING").toLowerCase(),
    fulfillment_status: node.displayFulfillmentStatus
      ? String(node.displayFulfillmentStatus).toLowerCase()
      : null,
    cancelled_at: node.cancelledAt ? String(node.cancelledAt) : null,
    test: Boolean(node.test),
    currency: String(
      (node.currentSubtotalPriceSet as { shopMoney?: { currencyCode?: string } })?.shopMoney
        ?.currencyCode ?? node.currencyCode ?? "USD",
    ),
    current_subtotal_price: String(
      (node.currentSubtotalPriceSet as { shopMoney?: { amount?: string } })?.shopMoney?.amount ??
        "0",
    ),
    total_discounts: String(
      (node.totalDiscountsSet as { shopMoney?: { amount?: string } })?.shopMoney?.amount ?? "0",
    ),
    total_tax: String(
      (node.totalTaxSet as { shopMoney?: { amount?: string } })?.shopMoney?.amount ?? "0",
    ),
    total_shipping_price_set: {
      shop_money: {
        amount: String(
          (node.totalShippingPriceSet as { shopMoney?: { amount?: string } })?.shopMoney?.amount ??
            "0",
        ),
      },
    },
    source_name: "import",
    line_items: lineEdges.map(({ node: line }) => {
      const product = line.product as
        | { id?: string; isGiftCard?: boolean; productType?: string }
        | undefined;
      const variant = line.variant as { id?: string } | undefined;
      return {
        admin_graphql_api_id: String(line.id),
        product_id: product?.id,
        variant_id: variant?.id,
        sku: line.sku ? String(line.sku) : null,
        title: line.title ? String(line.title) : undefined,
        quantity: Number(line.quantity ?? 0),
        price: String(
          (line.discountedTotalSet as { shopMoney?: { amount?: string } })?.shopMoney?.amount ?? "0",
        ),
        total_discount: "0",
        gift_card: Boolean(product?.isGiftCard || product?.productType === "Gift Card"),
      };
    }),
    refunds: refunds.map((refund) => {
      const rli =
        ((refund.refundLineItems as { edges?: Array<{ node: Record<string, unknown> }> })?.edges) ??
        [];
      return {
        admin_graphql_api_id: String(refund.id),
        processed_at: String(refund.createdAt),
        refund_line_items: rli.map(({ node: item }) => ({
          quantity: Number(item.quantity ?? 0),
          subtotal: String(
            (item.subtotalSet as { shopMoney?: { amount?: string } })?.shopMoney?.amount ?? "0",
          ),
        })),
      };
    }),
  };
}

export async function importOrdersPage(
  prisma: PrismaClient,
  admin: AdminGraphql,
  shopId: string,
  shopCurrencyCode: string,
  cursor: string | null,
) {
  const response = await admin.graphql(ORDERS_QUERY, { variables: { cursor } });
  const json = await response.json();
  if (json.errors?.length) {
    const msg = json.errors.map((e: { message: string }) => e.message).join("; ");
    // Common when read_all_orders is missing / limited history
    if (/access|denied|protected|forbidden/i.test(msg)) {
      await prisma.shop.update({
        where: { id: shopId },
        data: {
          historyAccessLimited: true,
          importStatus: "PARTIAL",
        },
      });
    }
    throw new Error(msg);
  }

  const connection = json.data?.orders;
  const edges = connection?.edges ?? [];
  for (const edge of edges) {
    await upsertNormalizedOrder(prisma, shopId, shopCurrencyCode, mapOrderNode(edge.node));
  }

  return {
    imported: edges.length,
    hasNextPage: Boolean(connection?.pageInfo?.hasNextPage),
    cursor: connection?.pageInfo?.endCursor ?? null,
  };
}

export async function finalizeImportCoverage(
  prisma: PrismaClient,
  shopId: string,
  rollingPeriodMonths: number,
) {
  const shop = await prisma.shop.findUniqueOrThrow({ where: { id: shopId } });
  const oldest = await prisma.normalizedOrders.findFirst({
    where: { shopId },
    orderBy: { processedAt: "asc" },
  });
  if (!oldest) {
    await prisma.shop.update({
      where: { id: shopId },
      data: {
        importStatus: "COMPLETE",
        historyAccessLimited: true,
        historyCoverageMonths: 0,
      },
    });
    return;
  }

  const monthsCovered = Math.max(
    0,
    (Date.now() - oldest.processedAt.getTime()) / (30.4375 * 24 * 60 * 60 * 1000),
  );
  const limited = monthsCovered + 0.5 < rollingPeriodMonths;
  await prisma.shop.update({
    where: { id: shopId },
    data: {
      importStatus: limited ? "PARTIAL" : "COMPLETE",
      historyAccessLimited: limited,
      historyCoverageMonths: Math.floor(monthsCovered),
      lastSuccessfulSyncAt: new Date(),
    },
  });

  if (limited) {
    await prisma.customerProfiles.updateMany({
      where: { shopId, historyStatus: { not: "COMPLETE" } },
      data: { historyStatus: "INSUFFICIENT", spendComplete: false },
    });
  } else {
    await prisma.customerProfiles.updateMany({
      where: { shopId },
      data: { historyStatus: "COMPLETE", spendComplete: true },
    });
  }

  await writeAuditLog(prisma, {
    shopId,
    actor: "importer",
    action: "import.finalize",
    entityType: "Shop",
    entityId: shopId,
    summary: limited
      ? `Import partial — ~${Math.floor(monthsCovered)} months coverage (need ${rollingPeriodMonths})`
      : "Import complete with sufficient history coverage",
    metadata: { shopDomain: shop.shopDomain, monthsCovered },
  });
}

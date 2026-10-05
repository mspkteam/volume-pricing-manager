/**
 * Qualifying spend calculation from normalized order data.
 */

import type { SpendPolicy } from "../../lib/policies";
import { addMinor, clampNonNegative, subMinor, type MoneyMinor } from "../../lib/money";
import { computeRollingWindow, isWithinWindow, type SpendWindow } from "../../lib/rolling-window";

export type NormalizedOrderForSpend = {
  processedAt: Date;
  financialStatus: string;
  cancelledAt: Date | null;
  test: boolean;
  currencyCode: string;
  merchandiseMinor: bigint;
  refundedMerchandiseMinor: bigint;
  qualifyingMinor: bigint;
  salesChannel: string | null;
  sourceName: string | null;
  lines: Array<{
    merchandiseMinor: bigint;
    isGiftCard: boolean;
    excluded: boolean;
    productId: string | null;
    collectionIds: string[];
  }>;
};

export type SpendBreakdown = {
  window: SpendWindow;
  qualifyingSpendMinor: MoneyMinor;
  includedOrderCount: number;
  refundDeductionMinor: MoneyMinor;
  excludedOrderCount: number;
  shopCurrencyCode: string;
  orders: Array<{
    processedAt: Date;
    qualifyingMinor: MoneyMinor;
    refundedMinor: MoneyMinor;
    included: boolean;
    excludeReason?: string;
  }>;
};

function channelAllowed(order: NormalizedOrderForSpend, policy: SpendPolicy): boolean {
  if (policy.includedSalesChannels.length === 0) return true;
  const channel = order.salesChannel || order.sourceName || "";
  return policy.includedSalesChannels.includes(channel);
}

function statusAllowed(status: string, policy: SpendPolicy): boolean {
  return policy.eligiblePaymentStatuses.map((s) => s.toLowerCase()).includes(status.toLowerCase());
}

/**
 * Recompute an order's qualifying merchandise given policy.
 * Uses shop-currency minor units only — never mixes presentment currencies.
 */
export function computeOrderQualifyingMinor(
  order: NormalizedOrderForSpend,
  policy: SpendPolicy,
  shopCurrencyCode: string,
): { qualifyingMinor: MoneyMinor; refundDeductionMinor: MoneyMinor; excludeReason?: string } {
  if (order.currencyCode !== shopCurrencyCode) {
    return {
      qualifyingMinor: 0n,
      refundDeductionMinor: 0n,
      excludeReason: `Order currency ${order.currencyCode} differs from shop currency ${shopCurrencyCode}`,
    };
  }
  if (policy.excludeTestOrders && order.test) {
    return { qualifyingMinor: 0n, refundDeductionMinor: 0n, excludeReason: "Test order" };
  }
  if (policy.excludeCancelled && order.cancelledAt) {
    return { qualifyingMinor: 0n, refundDeductionMinor: 0n, excludeReason: "Cancelled order" };
  }
  if (!statusAllowed(order.financialStatus, policy)) {
    return {
      qualifyingMinor: 0n,
      refundDeductionMinor: 0n,
      excludeReason: `Payment status ${order.financialStatus} not eligible`,
    };
  }
  if (!channelAllowed(order, policy)) {
    return { qualifyingMinor: 0n, refundDeductionMinor: 0n, excludeReason: "Sales channel excluded" };
  }

  let merchandise: MoneyMinor = 0n;
  for (const line of order.lines) {
    if (line.excluded) continue;
    if (policy.excludeGiftCards && line.isGiftCard) continue;
    if (line.productId && policy.excludedProductIds.includes(line.productId)) continue;
    if (line.collectionIds.some((c) => policy.excludedCollectionIds.includes(c))) continue;
    merchandise = addMinor(merchandise, BigInt(line.merchandiseMinor));
  }

  // Prefer stored order-level merchandise when lines empty (import edge case)
  if (order.lines.length === 0) {
    merchandise = BigInt(order.merchandiseMinor);
  }

  let refundDeduction = BigInt(order.refundedMerchandiseMinor);
  if (policy.preferOrderAdjustedTotals && order.qualifyingMinor > 0n) {
    // Canonical qualifying already net of refunds — avoid double deduction
    return {
      qualifyingMinor: clampNonNegative(BigInt(order.qualifyingMinor)),
      refundDeductionMinor: refundDeduction,
    };
  }

  const net = clampNonNegative(subMinor(merchandise, refundDeduction));
  return { qualifyingMinor: net, refundDeductionMinor: refundDeduction };
}

export function calculateQualifyingSpend(
  orders: NormalizedOrderForSpend[],
  policy: SpendPolicy,
  shopCurrencyCode: string,
  now: Date,
  timezone: string,
): SpendBreakdown {
  const window = computeRollingWindow(now, policy.rollingPeriodMonths, timezone);
  let qualifyingSpendMinor: MoneyMinor = 0n;
  let refundDeductionMinor: MoneyMinor = 0n;
  let includedOrderCount = 0;
  let excludedOrderCount = 0;
  const detail: SpendBreakdown["orders"] = [];

  for (const order of orders) {
    if (!isWithinWindow(order.processedAt, window)) {
      excludedOrderCount += 1;
      detail.push({
        processedAt: order.processedAt,
        qualifyingMinor: 0n,
        refundedMinor: 0n,
        included: false,
        excludeReason: "Outside rolling window",
      });
      continue;
    }
    const result = computeOrderQualifyingMinor(order, policy, shopCurrencyCode);
    if (result.excludeReason || result.qualifyingMinor === 0n) {
      if (result.excludeReason) excludedOrderCount += 1;
      detail.push({
        processedAt: order.processedAt,
        qualifyingMinor: result.qualifyingMinor,
        refundedMinor: result.refundDeductionMinor,
        included: result.qualifyingMinor > 0n && !result.excludeReason,
        excludeReason: result.excludeReason,
      });
      if (result.qualifyingMinor > 0n && !result.excludeReason) {
        qualifyingSpendMinor = addMinor(qualifyingSpendMinor, result.qualifyingMinor);
        refundDeductionMinor = addMinor(refundDeductionMinor, result.refundDeductionMinor);
        includedOrderCount += 1;
      }
      continue;
    }
    qualifyingSpendMinor = addMinor(qualifyingSpendMinor, result.qualifyingMinor);
    refundDeductionMinor = addMinor(refundDeductionMinor, result.refundDeductionMinor);
    includedOrderCount += 1;
    detail.push({
      processedAt: order.processedAt,
      qualifyingMinor: result.qualifyingMinor,
      refundedMinor: result.refundDeductionMinor,
      included: true,
    });
  }

  return {
    window,
    qualifyingSpendMinor,
    includedOrderCount,
    refundDeductionMinor,
    excludedOrderCount,
    shopCurrencyCode,
    orders: detail,
  };
}

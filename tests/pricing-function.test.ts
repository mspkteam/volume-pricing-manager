import { describe, expect, it } from "vitest";
import { run } from "../extensions/volume-tier-discount/src/run.js";

describe("discount function", () => {
  it("applies authorized percentage from config map by stable tier id", () => {
    const result = run({
      cart: {
        buyerIdentity: {
          customer: {
            id: "gid://shopify/Customer/1",
            metafield: {
              jsonValue: { tierId: "tier_trade", discountBps: 9999 },
            },
          },
        },
        lines: [
          {
            id: "gid://shopify/CartLine/1",
            quantity: 1,
            cost: { subtotalAmount: { amount: "100.00" } },
            merchandise: {
              __typename: "ProductVariant",
              id: "gid://shopify/ProductVariant/1",
              product: { id: "gid://shopify/Product/1", productType: "Part" },
            },
          },
        ],
      },
      discount: {
        metafield: {
          jsonValue: {
            tiers: { tier_trade: 2500 },
            messagePrefix: "Volume pricing",
          },
        },
      },
    });

    const candidate = result.operations[0]?.productDiscountsAdd.candidates[0];
    expect(candidate?.value.percentage.value).toBe("25.00");
  });

  it("fails safe with no customer / missing config", () => {
    expect(
      run({
        cart: { buyerIdentity: { customer: null }, lines: [] },
        discount: { metafield: null },
      }).operations,
    ).toEqual([]);

    expect(
      run({
        cart: {
          buyerIdentity: {
            customer: {
              id: "gid://shopify/Customer/1",
              metafield: { jsonValue: { tierId: "unknown", discountBps: 5000 } },
            },
          },
          lines: [
            {
              id: "line1",
              quantity: 1,
              cost: { subtotalAmount: { amount: "10.00" } },
              merchandise: { __typename: "ProductVariant", product: { id: "p1" } },
            },
          ],
        },
        discount: { metafield: { jsonValue: { tiers: { other: 1000 } } } },
      }).operations,
    ).toEqual([]);
  });
});

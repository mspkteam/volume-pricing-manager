import { describe, expect, it } from "vitest";
import { assertShopScope } from "../app/services/shop/shop-service";

describe("cross-shop isolation", () => {
  it("rejects mismatched shop ids", () => {
    expect(() => assertShopScope("shop_a", "shop_b", "tier")).toThrow(/Forbidden/);
  });

  it("allows matching shop ids", () => {
    expect(() => assertShopScope("shop_a", "shop_a", "tier")).not.toThrow();
  });
});

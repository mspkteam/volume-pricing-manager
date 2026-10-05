import { describe, expect, it } from "vitest";
import {
  DiscountFunctionPricingProvider,
} from "../app/services/pricing/discount-function-provider";

describe("pricing provider compatibility", () => {
  it("requires setup when distribution/plan unknown", async () => {
    const provider = new DiscountFunctionPricingProvider(null, { writesEnabled: false });
    const result = await provider.verifyCompatibility({
      shopDomain: "example.myshopify.com",
      distribution: "unknown",
      functionsAvailable: null,
    });
    expect(result.compatibility).toBe("SETUP_REQUIRED");
    expect(result.status).toBe("NOT_CONFIGURED");
  });

  it("marks custom non-Plus as unsupported", async () => {
    const provider = new DiscountFunctionPricingProvider(null, { writesEnabled: false });
    const result = await provider.verifyCompatibility({
      shopDomain: "example.myshopify.com",
      distribution: "custom",
      planName: "Shopify",
      functionsAvailable: true,
    });
    expect(result.compatibility).toBe("UNSUPPORTED");
    expect(result.status).toBe("UNSUPPORTED");
  });

  it("supports App Store distribution with functions", async () => {
    const provider = new DiscountFunctionPricingProvider(null, { writesEnabled: false });
    const result = await provider.verifyCompatibility({
      shopDomain: "example.myshopify.com",
      distribution: "app_store",
      planName: "Basic",
      functionsAvailable: true,
    });
    expect(result.compatibility).toBe("SUPPORTED");
    expect(result.status).toBe("READY");
  });

  it("does not write to Shopify when writes disabled", async () => {
    const provider = new DiscountFunctionPricingProvider(null, { writesEnabled: false });
    const sync = await provider.syncCustomer({
      shopDomain: "example.myshopify.com",
      shopifyCustomerId: "gid://shopify/Customer/1",
      tierId: "t1",
      discountBps: 1500,
      tierName: "Bronze",
      configVersion: 1,
      assignmentVersion: 1,
    });
    expect(sync.status).toBe("NOT_CONFIGURED");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildWholesaleTags,
  diffWholesaleTags,
  parseWholesaleAccessPolicy,
} from "../app/services/wholesale/policy";

describe("wholesale access tags", () => {
  const policy = parseWholesaleAccessPolicy({});

  it("builds Clay-compatible tags for approved wholesale customer", () => {
    const { desired } = buildWholesaleTags({
      policy,
      businessApproved: true,
      tierName: "Wholesale",
      discountBps: 3000,
    });
    expect(desired).toContain("vpm");
    expect(desired).toContain("vpm-approved");
    expect(desired).toContain("Wholesale");
    expect(desired).toContain("vpm-pct-30");
    expect(desired).toContain("vpm-tier-wholesale");
  });

  it("omits approved tag when not approved", () => {
    const { desired } = buildWholesaleTags({
      policy,
      businessApproved: false,
      tierName: "Retailer",
      discountBps: 1000,
    });
    expect(desired).not.toContain("vpm-approved");
    expect(desired).toContain("Retailer");
    expect(desired).toContain("vpm-pct-10");
  });

  it("diffs tags without removing unrelated merchant tags", () => {
    const { desired } = buildWholesaleTags({
      policy,
      businessApproved: true,
      tierName: "Distributor",
      discountBps: 2000,
    });
    const { toAdd, toRemove } = diffWholesaleTags({
      existingTags: ["VIP", "Wholesale", "vpm-pct-30", "newsletter"],
      desired,
      policy,
      knownTierNames: ["Wholesale", "Distributor", "Retailer"],
    });
    expect(toRemove).toContain("Wholesale");
    expect(toRemove).toContain("vpm-pct-30");
    expect(toRemove).not.toContain("VIP");
    expect(toRemove).not.toContain("newsletter");
    expect(toAdd).toContain("Distributor");
    expect(toAdd).toContain("vpm-pct-20");
    expect(toAdd).toContain("vpm-approved");
  });
});

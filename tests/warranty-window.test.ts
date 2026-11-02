import { describe, expect, it } from "vitest";
import { isWithinWarrantyWindow } from "../app/services/warranty/settings";

describe("isWithinWarrantyWindow", () => {
  it("returns null when purchase date is missing", () => {
    expect(isWithinWarrantyWindow(null, 365)).toBeNull();
  });

  it("treats windowDays <= 0 as always in window", () => {
    const purchase = new Date("2020-01-01T00:00:00Z");
    expect(isWithinWarrantyWindow(purchase, 0, new Date("2026-01-01T00:00:00Z"))).toBe(true);
  });

  it("flags claims outside the configured window", () => {
    const purchase = new Date("2024-01-01T00:00:00Z");
    const now = new Date("2025-06-01T00:00:00Z");
    expect(isWithinWarrantyWindow(purchase, 365, now)).toBe(false);
  });

  it("accepts claims inside the configured window", () => {
    const purchase = new Date("2025-01-01T00:00:00Z");
    const now = new Date("2025-06-01T00:00:00Z");
    expect(isWithinWarrantyWindow(purchase, 365, now)).toBe(true);
  });
});

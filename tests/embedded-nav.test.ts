import { describe, expect, it } from "vitest";
import { withEmbeddedSearch } from "../app/lib/embedded-nav";

describe("withEmbeddedSearch", () => {
  it("appends shop/host search params to a path", () => {
    expect(
      withEmbeddedSearch("/app/forms", "?shop=demo.myshopify.com&host=abc"),
    ).toBe("/app/forms?shop=demo.myshopify.com&host=abc");
  });

  it("leaves paths that already have a query alone", () => {
    expect(withEmbeddedSearch("/app/forms?x=1", "?shop=demo.myshopify.com")).toBe(
      "/app/forms?x=1",
    );
  });

  it("returns the path when search is empty", () => {
    expect(withEmbeddedSearch("/app/tiers", "")).toBe("/app/tiers");
    expect(withEmbeddedSearch("/app/tiers", "?")).toBe("/app/tiers");
  });

  it("handles search without a leading ?", () => {
    expect(withEmbeddedSearch("/app", "shop=x&host=y")).toBe("/app?shop=x&host=y");
  });
});

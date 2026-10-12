import { expect, test } from "@playwright/test";
import { withEmbeddedSearch } from "../app/lib/embedded-nav";

test.describe("embedded admin navigation helpers", () => {
  test("tab paths keep shop + host", () => {
    const search = "?shop=demo.myshopify.com&host=YWRtaW4&embedded=1";
    const tabs = [
      "/app",
      "/app/tiers",
      "/app/customers",
      "/app/applications",
      "/app/forms",
      "/app/wholesale",
      "/app/settings",
    ];
    for (const tab of tabs) {
      const next = withEmbeddedSearch(tab, search);
      expect(next).toContain("shop=demo.myshopify.com");
      expect(next).toContain("host=YWRtaW4");
      expect(next.startsWith(tab)).toBe(true);
    }
  });

  test("form embed deep links keep session params", () => {
    const search = "?shop=demo.myshopify.com&host=abc";
    expect(withEmbeddedSearch("/app/forms/cuid123/embed", search)).toBe(
      "/app/forms/cuid123/embed?shop=demo.myshopify.com&host=abc",
    );
  });
});

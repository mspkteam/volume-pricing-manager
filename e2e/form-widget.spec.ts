import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const widgetJs = readFileSync(
  join(root, "extensions/volume-pricing-form/assets/vpm-form.js"),
  "utf8",
);
const widgetCss = readFileSync(
  join(root, "extensions/volume-pricing-form/assets/vpm-form.css"),
  "utf8",
);
const pageHtml = readFileSync(join(root, "e2e/fixtures/form-page.html"), "utf8");

const publishedSchema = {
  title: "Wholesale Application",
  description: "Apply for volume pricing.",
  submitLabel: "Send application",
  successMessage: "Thanks — we got it.",
  requireLogin: false,
  loggedInCustomerId: null,
  cacheKey: "cache-1",
  fields: [
    {
      id: "company",
      type: "short_text",
      label: "Company name",
      required: true,
    },
    {
      id: "email",
      type: "email",
      label: "Work email",
      required: true,
    },
  ],
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function startFixtureServer() {
  const submissions: unknown[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");

    if (url.pathname === "/" || url.pathname === "/form") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(pageHtml);
      return;
    }
    if (url.pathname === "/vpm-form.js") {
      res.writeHead(200, { "Content-Type": "application/javascript; charset=utf-8" });
      res.end(widgetJs);
      return;
    }
    if (url.pathname === "/vpm-form.css") {
      res.writeHead(200, { "Content-Type": "text/css; charset=utf-8" });
      res.end(widgetCss);
      return;
    }
    if (url.pathname === "/apps/volume-pricing/forms/form_test_123") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(publishedSchema));
      return;
    }
    if (url.pathname === "/apps/volume-pricing/forms/form_test_123/submit" && req.method === "POST") {
      const raw = await readBody(req);
      submissions.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, submissionId: "sub_1" }));
      return;
    }
    if (url.pathname === "/apps/volume-pricing/forms/missing") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Form not found" }));
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No port");
  return {
    port: address.port,
    baseURL: `http://127.0.0.1:${address.port}`,
    submissions,
    close: async () => {
      if (typeof server.closeAllConnections === "function") {
        server.closeAllConnections();
      }
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}

test.describe("storefront form widget", () => {
  test("loads schema and leaves Loading form…", async ({ page }) => {
    const fixture = await startFixtureServer();
    try {
      await page.goto(`${fixture.baseURL}/form`);
      await expect(page.getByText("Loading form…")).toBeHidden({ timeout: 5000 });
      await expect(page.getByRole("heading", { name: "Wholesale Application" })).toBeVisible();
      await expect(page.getByLabel("Company name")).toBeVisible();
      await expect(page.getByLabel("Work email")).toBeVisible();
      await expect(page.getByRole("button", { name: "Send application" })).toBeVisible();
    } finally {
      await fixture.close();
    }
  });

  test("submits answers and shows success", async ({ page }) => {
    const fixture = await startFixtureServer();
    try {
      await page.goto(`${fixture.baseURL}/form`);
      await expect(page.getByLabel("Company name")).toBeVisible();
      await page.getByLabel("Company name").fill("Acme Wholesale");
      await page.getByLabel("Work email").fill("buyer@acme.test");
      await page.getByRole("button", { name: "Send application" }).click();
      await expect(page.getByText("Thanks — we got it.")).toBeVisible();
      expect(fixture.submissions).toHaveLength(1);
      const body = fixture.submissions[0] as { answers: Record<string, string> };
      expect(body.answers.company).toBe("Acme Wholesale");
      expect(body.answers.email).toBe("buyer@acme.test");
    } finally {
      await fixture.close();
    }
  });

});

test("shows Form not found for a bad form id", async ({ page }) => {
  const fixture = await startFixtureServer();
  try {
    await page.route("**/apps/volume-pricing/forms/missing**", async (route) => {
      await route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "Form not found" }),
      });
    });
    await page.goto(`${fixture.baseURL}/form`);
    await page.evaluate(() => {
      const root = document.querySelector("[data-vpm-form]") as HTMLElement;
      root.setAttribute("data-form-id", "missing");
      root.setAttribute("data-proxy-base", "/apps/volume-pricing/forms/missing");
      root.removeAttribute("data-vpm-mounted");
      root.querySelector("[data-vpm-loading]")!.removeAttribute("hidden");
      (window as unknown as { VPMForm: { refresh: () => void } }).VPMForm.refresh();
    });
    await expect(page.getByText("Form not found")).toBeVisible({ timeout: 5000 });
    await expect(page.getByText("Loading form…")).toBeHidden();
  } finally {
    await fixture.close();
  }
});

test("widget route file uses bracket escape for .js URL", async () => {
  const { readdirSync } = await import("node:fs");
  const routes = readdirSync(join(root, "app/routes"));
  expect(routes.some((f) => f.includes("vpm-form[.]js"))).toBe(true);
  expect(routes.some((f) => f === "proxy.widget.vpm-form.js.tsx")).toBe(false);
});

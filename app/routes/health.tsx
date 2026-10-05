import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";

/**
 * Lightweight health check for Vercel / ops.
 * Does not expose secrets. Use to verify DATABASE_URL + Session table.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const checks: Record<string, string> = {
    ok: "true",
    hasDatabaseUrl: process.env.DATABASE_URL ? "true" : "false",
    hasShopifyApiKey: process.env.SHOPIFY_API_KEY ? "true" : "false",
    hasShopifyAppUrl: process.env.SHOPIFY_APP_URL ? "true" : "false",
    shopifyAppUrl: process.env.SHOPIFY_APP_URL || "",
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "connected";
    const sessions = await prisma.session.count();
    checks.sessionTable = "ok";
    checks.sessionCount = String(sessions);
  } catch (err) {
    checks.ok = "false";
    checks.database = "error";
    checks.databaseError =
      err instanceof Error ? err.message.slice(0, 200) : "unknown";
  }

  // Only return detailed errors when ?debug=1 (still no secrets)
  if (url.searchParams.get("debug") !== "1") {
    delete checks.databaseError;
    delete checks.shopifyAppUrl;
  }

  return Response.json(checks, {
    status: checks.ok === "true" ? 200 : 503,
  });
};

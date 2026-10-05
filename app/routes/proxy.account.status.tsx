import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { rateLimit } from "../services/forms/rate-limit";
import { formatMoney } from "../lib/money";

/**
 * Authenticated customer status via app proxy.
 * Requires logged_in_customer_id (Shopify-signed query param).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);
  if (!session?.shop) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const shop = await ensureShop(prisma, session.shop);
  const url = new URL(request.url);
  const customerId = url.searchParams.get("logged_in_customer_id");
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const rl = rateLimit(`account:${shop.id}:${ip}`, 40, 60_000);
  if (!rl.ok) {
    return Response.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } },
    );
  }

  if (!customerId) {
    return Response.json(
      { error: "Login required", authenticated: false },
      { status: 401 },
    );
  }

  const profile = await prisma.customerProfiles.findFirst({
    where: { shopId: shop.id, shopifyCustomerId: customerId },
    include: { effectiveTier: true, calculatedTier: true },
  });

  const submissions = await prisma.formSubmissions.findMany({
    where: { shopId: shop.id, shopifyCustomerId: customerId },
    orderBy: { submittedAt: "desc" },
    take: 10,
    include: { form: { select: { title: true, handle: true } } },
  });

  return Response.json({
    authenticated: true,
    customerId,
    application: submissions[0]
      ? {
          id: submissions[0].id,
          status: submissions[0].status,
          formTitle: submissions[0].form.title,
          formHandle: submissions[0].form.handle,
          submittedAt: submissions[0].submittedAt.toISOString(),
          customerMessage: submissions[0].customerMessage,
        }
      : null,
    applications: submissions.map((s) => ({
      id: s.id,
      status: s.status,
      formTitle: s.form.title,
      formHandle: s.form.handle,
      submittedAt: s.submittedAt.toISOString(),
    })),
    tier: profile
      ? {
          effective: profile.effectiveTier?.name ?? null,
          calculated: profile.calculatedTier?.name ?? null,
          pricingSyncStatus: profile.pricingSyncStatus,
          businessApproved: profile.businessApproved,
        }
      : null,
    spend: profile
      ? {
          qualifying: formatMoney(profile.qualifyingSpendMinor, shop.currencyCode),
          currencyCode: shop.currencyCode,
          orderCount: profile.includedOrderCount,
          windowStart: profile.windowStart?.toISOString() ?? null,
          windowEnd: profile.windowEnd?.toISOString() ?? null,
        }
      : null,
  });
};

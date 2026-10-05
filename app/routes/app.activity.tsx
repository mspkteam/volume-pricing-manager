import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const url = new URL(request.url);
  const action = url.searchParams.get("action") ?? "";

  const logs = await prisma.auditLogs.findMany({
    where: {
      shopId: shop.id,
      ...(action ? { action: { contains: action } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  const syncFailures = await prisma.pricingSyncJobs.findMany({
    where: { shopId: shop.id, status: "FAILED" },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  return {
    logs: logs.map((l) => ({
      id: l.id,
      at: l.createdAt,
      actor: l.actor,
      action: l.action,
      entityType: l.entityType,
      summary: l.summary,
      reason: l.reason,
    })),
    syncFailures: syncFailures.map((s) => ({
      id: s.id,
      at: s.createdAt,
      error: s.lastError,
      customerProfileId: s.customerProfileId,
    })),
  };
};

export default function ActivityPage() {
  const { logs, syncFailures } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Activity">
      <s-section heading="Audit trail">
        <s-paragraph>
          Tier changes, approvals, overrides, configuration, imports, and sync events. Sensitive
          values are redacted.
        </s-paragraph>
        {logs.length === 0 ? (
          <s-paragraph>No activity yet.</s-paragraph>
        ) : (
          <s-unordered-list>
            {logs.map((l) => (
              <s-list-item key={l.id}>
                {String(l.at)} · {l.actor} · {l.action} · {l.summary}
                {l.reason ? ` — ${l.reason}` : ""}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>

      <s-section heading="Pricing synchronization failures">
        {syncFailures.length === 0 ? (
          <s-paragraph>No pricing sync failures recorded.</s-paragraph>
        ) : (
          <s-unordered-list>
            {syncFailures.map((s) => (
              <s-list-item key={s.id}>
                {String(s.at)} · customer {s.customerProfileId} — {s.error}
              </s-list-item>
            ))}
          </s-unordered-list>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);

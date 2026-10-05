import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop/shop-service";
import { EmptyState, PageIntro } from "../components/admin/ui";
import { formatDateTime } from "../lib/format";

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
      <PageIntro>
        Tier changes, approvals, overrides, configuration, imports, and sync events. Sensitive values
        are redacted in summaries.
      </PageIntro>

      <s-section heading="Audit trail">
        {logs.length === 0 ? (
          <EmptyState title="No activity yet" body="Actions from the admin and background jobs will appear here." />
        ) : (
          <div className="vpm-panel">
            {logs.map((l) => (
              <div key={l.id} className="vpm-change-row">
                <s-text type="strong">{l.action}</s-text> — {l.summary}
                <div className="vpm-change-meta">
                  {formatDateTime(l.at.toISOString())} · {l.actor}
                  {l.reason ? ` · ${l.reason}` : ""}
                </div>
              </div>
            ))}
          </div>
        )}
      </s-section>

      <s-section heading="Pricing synchronization failures">
        {syncFailures.length === 0 ? (
          <EmptyState title="No sync failures" body="Customer pricing sync errors will be listed here for follow-up." />
        ) : (
          <div className="vpm-panel">
            {syncFailures.map((s) => (
              <div key={s.id} className="vpm-change-row">
                Customer {s.customerProfileId}
                <div className="vpm-change-meta">
                  {formatDateTime(s.at.toISOString())} — {s.error}
                </div>
              </div>
            ))}
          </div>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);

import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  ensureShop,
  parseAutomationPolicy,
  parseSpendPolicy,
} from "../services/shop/shop-service";
import { buildExplainer } from "../services/explainer/build-explainer";
import { ChecklistPanel, PageIntro } from "../components/admin/ui";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(prisma, session.shop);
  const tiers = await prisma.pricingTier.findMany({
    where: { shopId: shop.id, isArchived: false },
  });

  const explainer = buildExplainer({
    displayName: shop.displayName,
    currencyCode: shop.currencyCode,
    timezone: shop.timezone,
    spendPolicy: parseSpendPolicy(shop.spendPolicy),
    automationPolicy: parseAutomationPolicy(shop.automationPolicy),
    tiers,
    pricingStatus: shop.pricingStatus,
    pricingProviderLabel: "Shopify Discount Function",
    historyAccessLimited: shop.historyAccessLimited,
  });

  return { explainer };
};

export default function HowItWorksPage() {
  const { explainer } = useLoaderData<typeof loader>();

  return (
    <s-page heading={explainer.title}>
      <PageIntro>
        This page reflects your live tier names, thresholds, and policies — use it when training staff
        or explaining the program to buyers.
      </PageIntro>

      <s-section heading="At a glance">
        <div className="vpm-panel vpm-panel--subdued">
          <s-paragraph>{explainer.dynamicExample}</s-paragraph>
          <s-paragraph>
            Rolling period: <s-text type="strong">{explainer.periodLabel}</s-text>
          </s-paragraph>
        </div>
      </s-section>

      <s-section heading="Onboarding checklist">
        <ChecklistPanel items={explainer.checklist} />
        <s-stack direction="inline" gap="base">
          <s-button href="/app/tiers">Create tiers</s-button>
          <s-button href="/app/settings" variant="secondary">
            Pricing setup
          </s-button>
          <s-button href="/app/simulator" variant="tertiary">
            Open simulator
          </s-button>
        </s-stack>
      </s-section>

      {explainer.ranges.length > 0 ? (
        <s-section heading="Your current spend ranges">
          <s-unordered-list>
            {explainer.ranges.map((r) => (
              <s-list-item key={r.name}>
                {r.name}: {r.label} · {r.discount} off
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-section>
      ) : null}

      {explainer.sections.map((section) => (
        <s-section key={section.heading} heading={section.heading}>
          <s-paragraph>{section.body}</s-paragraph>
        </s-section>
      ))}

      <s-section heading="Planned HVAC capabilities (not operational yet)">
        <s-banner tone="warning">
          These are extension points only. They are not live features in this release.
        </s-banner>
        <s-unordered-list>
          {explainer.plannedCapabilities.map((c) => (
            <s-list-item key={c}>{c}</s-list-item>
          ))}
        </s-unordered-list>
        <s-paragraph>
          Rebates, freight benefits, payment terms, and MOQ enforcement require separate verified
          implementations. An app-stored flag is not a Shopify payment term, and a storefront message
          is not MOQ enforcement.
        </s-paragraph>
      </s-section>

      <s-section heading="How Wholesale Access Works (Clay-like, automated)">
        <s-paragraph>
          This app is designed to replace Clay B2B Wholesale + Clay B2B Lock with automated tiers:
          apply → approve → tag sync → storefront prices unlock → spend keeps tiers updated.
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            Publish a form and embed it on the Applications page (replace the Clay registration block
            when ready).
          </s-list-item>
          <s-list-item>
            On approval, the app sets business eligibility, runs the tier engine, and syncs Shopify
            tags (<code>vpm-approved</code>, tier name, <code>vpm-pct-N</code>).
          </s-list-item>
          <s-list-item>
            The theme shows discounts from those tags and locks prices from non-approved shoppers.
          </s-list-item>
          <s-list-item>
            Checkout Discount Function sync is separate and stays gated until pricing writes are
            verified — tags still unlock PDP pricing without it.
          </s-list-item>
        </s-unordered-list>
        <s-button href="/app/wholesale">Wholesale access settings</s-button>
      </s-section>

      <s-section heading="How Forms Work">
        <s-paragraph>
          Forms are a publishable storefront intake layer — not automatic tier assignment. Merchants
          build fields in the admin builder, publish a versioned schema, and embed the theme app block
          with a pasted form handle (Theme Editor cannot dynamically list forms).
        </s-paragraph>
        <s-unordered-list>
          <s-list-item>
            Storefront loads schema from app proxy <code>/apps/volume-pricing/forms/{"{handle}"}</code>.
          </s-list-item>
          <s-list-item>
            Submissions are reviewed in Applications. Approving eligibility is separate from pricing
            sync and does not auto-grant a requested tier.
          </s-list-item>
          <s-list-item>
            Optional audited starting-tier overrides (projected volume) require a reason and are
            logged. Spend-based qualification still runs through the existing tier engine.
          </s-list-item>
          <s-list-item>
            File uploads need private object storage env vars; until configured, upload fields show a
            setup message and cannot accept documents.
          </s-list-item>
        </s-unordered-list>
        <s-stack direction="inline" gap="base">
          <s-button href="/app/forms">Open forms</s-button>
          <s-button href="/app/applications" variant="secondary">
            Applications inbox
          </s-button>
        </s-stack>
      </s-section>

      <s-section heading="FAQ">
        <s-paragraph>
          <strong>Why was a customer downgraded with no new order?</strong> Purchases left the
          rolling window during the daily recalculation.
        </s-paragraph>
        <s-paragraph>
          <strong>Why didn’t a high-spend customer get the top tier?</strong> Eligibility
          requirements (approval, license, etc.) were not met, so a lower eligible tier was chosen.
        </s-paragraph>
        <s-paragraph>
          <strong>Tier says assigned but checkout didn’t discount?</strong> Assignment and pricing
          sync are separate. Check Settings for pricing status (currently {explainer.pricingStatus}).
        </s-paragraph>
        <s-paragraph>
          <strong>Are these app billing plans?</strong> No. These are customer pricing tiers for your
          storefront/checkout — not Shopify app subscription plans.
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (h) => boundary.headers(h);

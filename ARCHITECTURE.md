# Architecture — Volume Pricing Manager

## Purpose

Merchants configure **customer pricing tiers** (not app billing plans). The app:

1. Syncs orders into a shop-scoped normalized store
2. Calculates qualifying spend over a rolling calendar-month window
3. Evaluates eligibility (approval, license, etc.)
4. Assigns calculated / effective / pending / override tiers
5. Synchronizes the effective tier into a pluggable Shopify pricing provider

The existing Horizon theme export in the parent folder is unchanged. This app lives in `volume-pricing-manager/`.

## Stack

| Layer | Choice |
|---|---|
| App framework | Shopify official React Router template (`@shopify/shopify-app-react-router`) |
| Language | TypeScript |
| Admin API | GraphQL, pinned **`2025-10`** (`ApiVersion.October25`) |
| Database | PostgreSQL + Prisma |
| Jobs | Durable PostgreSQL job queue (`BackgroundJobs`) + independent `npm run worker` |
| Money | Integer minor units + Decimal.js (no floats) |
| UI | Shopify Polaris web components (embedded admin) |

## Shop isolation

Every merchant record includes `shopId` / `shopDomain`. Services use `ensureShop` / `assertShopScope`. Workers and webhooks key jobs by shop. Uninstall cancels pending jobs and marks the shop uninstalled; `shop/redact` deletes shop data.

## Data flow

```
Shopify webhooks / import
        │
        ▼
 WebhookEvents (durable, idempotent)
        │
        ▼
 BackgroundJobs (worker)
        │
        ├─► NormalizedOrders (+ lines, refunds)
        │
        ▼
 Spend calculation (shop TZ rolling window)
        │
        ▼
 Eligibility + assignment decision
        │
        ├─► CustomerProfiles (calculated / effective / pending / override)
        ├─► TierAssignmentHistory + AuditLogs
        │
        ▼
 PricingSyncJobs → PricingProvider
        │
        ▼
 Shopify (metafields / automatic discount Function)  [gated]
```

## Qualifying spend (defaults)

- Rolling **12 calendar months** in the **shop timezone**
- Paid merchandise after discounts; **exclude tax & shipping**
- Deduct attributable refunded merchandise
- Exclude cancelled & test orders; exclude gift cards by default
- Shop-currency amounts only — never sum mixed presentment currencies
- Prefer `current_subtotal` when present to avoid double-counting refunds
- Month-end / leap-year boundaries clamp to the last valid day of the target month
- Window: start 00:00:00.000 shop TZ on the calendar day N months ago → end 23:59:59.999 shop TZ today (inclusive)

Orders qualify customers for **future** purchases after the eligible payment event is processed. Historical order prices are never retroactively rewritten by this app.

## Tier engine

- No fixed tier enums or name-based branching
- Qualification uses stable IDs + `minSpendMinor` + eligibility flags
- Highest tier that passes **both** spend and eligibility wins
- Unapproved high spenders fall through to lower eligible tiers / fallback
- Display order is independent of qualification precedence
- Spend ranges are half-open: `[min, nextMin)`

## Assignment states

| State | Meaning |
|---|---|
| Calculated | Engine result from spend + eligibility |
| Effective | Tier used for pricing sync |
| Pending | Waiting for review / grace / approval path |
| Override | Manual admin assignment (reason, optional expiry, optional automation pause) |

Upgrades default to immediate; downgrades default to grace period. Daily recalculation still runs while changes wait for review — so spend figures stay current even when assignment is deferred.

Incomplete history → `INSUFFICIENT` / `PARTIAL`. By default, **do not auto-downgrade** on incomplete imports.

## Pricing compatibility decision

### Selected approach: Shopify Discount Function (provider id `discount_function`)

**How it works when enabled**

1. Deploy extension `extensions/volume-tier-discount`
2. Create an automatic app discount bound to the Function
3. Sync shop config metafield `$app:volume_pricing.function_configuration` with `{ tiers: { [tierId]: discountBps } }`
4. Sync customer metafield `$app:volume_pricing.tier` with `{ tierId, discountBps, versions… }`
5. At checkout, the Function reads **trusted** discount metafield + customer metafield; applies percentage off **selling price** (cart line subtotal). Unknown tier IDs / logged-out carts → no discount (fail safe).

**Plan / distribution constraints (official Shopify Functions policy)**

- **App Store** apps with Functions: usable on **all** Shopify plans
- **Custom-distributed** apps with Functions: **Shopify Plus / Enterprise only**

Because this workspace’s store plan and app distribution are **unknown**, the app:

- Builds the full tier engine, admin UI, sync, and jobs
- Surfaces pricing as **Setup required / NOT_CONFIGURED**
- Keeps `PRICING_WRITES_ENABLED=false` by default (no live checkout writes)

### Alternatives considered (not default)

| Approach | When appropriate | Notes |
|---|---|---|
| B2B catalogs | Plus + B2B | Different buyer journey; not interchangeable with DTC tier discounts |
| Native customer-segment automatic discounts | Broad plans | Possible per-tier segment + % discount; segment lag; less precise than Functions |
| Draft orders / discount codes | Last resort | Changes shopper journey — must be surfaced honestly, never silently |

Storefront-only price display changes are **not** a substitute for checkout discounts.

### Status model (separate from tier assignment)

`NOT_CONFIGURED` → `READY` → `SYNCING` → `SYNCED` | `FAILED` | `UNSUPPORTED`

A customer can have an effective tier while pricing sync is still Setup required.

## Concurrency & recovery

- Job claim uses `FOR UPDATE SKIP LOCKED`
- Pricing sync jobs store `configVersion` + `assignmentVersion`; newer versions win
- If DB updates succeed but Shopify writes fail, job retries with backoff; failures visible in Activity / Automation
- Webhook duplicates keyed by `(shopDomain, topic, payloadHash)`

## Planned HVAC extensions (not operational in v1)

Documented extension points only:

- Tier-specific pack sizes / MOQs
- Product quantity rules
- Net payment terms after qualifying order counts
- Annual rebates
- Freight allowances
- Priority fulfillment

Do not equate an app flag with Shopify payment terms or real MOQ enforcement.

## Company-level spend

Default is **customer-level** spend using Shopify customer IDs. Email matching does not merge customers. Company / company-location aggregation is a future extension.

# Volume Pricing Manager

Embedded Shopify app that calculates customer qualifying spend over a rolling period, assigns configurable pricing tiers, and synchronizes tiers to a checkout pricing provider when compatible.

This app sits beside the existing Brightline / Horizon theme export — theme files are not modified by the app scaffold.

## What works today

- Configurable pricing tiers (create / rename / thresholds / discounts / eligibility / fallback / archive)
- Optional HVAC starter preset (Retail / Tier C / B / A) — fully editable, not hardcoded logic
- Qualifying spend engine (rolling months, refunds, exclusions, shop currency, Decimal/minor units)
- Eligibility + assignment (upgrade/downgrade/grace/review/overrides/incomplete-history protection)
- Shop-scoped Prisma schema (PostgreSQL)
- Durable webhook intake + background worker/scheduler
- Admin route structure for Dashboard, Tiers, Customers, Automation, Simulator, Activity, Settings, How It Works
- Discount Function extension + `PricingProvider` interface (writes gated)
- Automated unit tests for money, windows, tiers, assignment, spend, pricing compatibility

## Blocked / setup required

| Item | Blocker |
|---|---|
| Live checkout discounts | Store plan + app distribution not verified; `PRICING_WRITES_ENABLED=false` by default |
| Custom app + Functions | Requires Shopify Plus/Enterprise |
| Dev-store checkout verification | Needs Partner app credentials + installed dev store |
| `read_all_orders` full 12-month history | Protected customer data approval in Partner Dashboard |
| Production deploy | Not performed (per requirements) |

## Prerequisites

- Node.js **≥ 22.12**
- PostgreSQL
- Shopify Partner account + development store
- Shopify CLI (`shopify version`)

## Setup

```bash
cd volume-pricing-manager
cp .env.example .env
# Edit DATABASE_URL and leave PRICING_WRITES_ENABLED=false until verified

npm install
npx prisma migrate dev --name volume_pricing_init
npm run worker   # separate terminal
npm run dev      # shopify app dev — embeds in admin
```

### Required scopes

See `shopify.app.toml`:

`read_customers,write_customers,read_orders,read_products,write_discounts,read_discounts,write_products`

`read_all_orders` is **not** in the default install scopes — Shopify rejects it until you request and receive approval in Partner Dashboard → API access requests. Without it, history is limited to roughly the last 60 days; the UI shows **Insufficient history** and will not auto-downgrade by default.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Shopify app dev (tunnel + embed) |
| `npm run worker` | Background job worker + daily scheduler |
| `npm run build` | Production build |
| `npm run setup` | `prisma generate && prisma migrate deploy` |
| `npm test` | Vitest unit tests |
| `npm run typecheck` | TypeScript check |
| `npm run lint` | ESLint |

## Pricing provider

Default provider: **Shopify Discount Function** (`extensions/volume-tier-discount`).

Documented decision and constraints: see [ARCHITECTURE.md](./ARCHITECTURE.md).

Until compatibility is verified:

1. Keep `PRICING_WRITES_ENABLED=false`
2. Admin Settings shows pricing status **Setup required**
3. Tier assignment and spend automation still operate

To enable after verification:

1. Confirm distribution (App Store vs custom) and plan (Plus if custom)
2. Deploy Function: `shopify app deploy` (or `shopify app function build`)
3. Create automatic app discount bound to `volume-tier-discount`
4. Set `PRICING_WRITES_ENABLED=true`
5. Run a logged-in checkout test on a development store

## Worker

The worker must run independently of HTTP requests:

```bash
npm run worker
```

It claims jobs with `FOR UPDATE SKIP LOCKED`, processes webhooks, recalculations, override expiry, daily rolling-window downgrades, and pricing sync retries.

## Branding

Default display name: **Volume Pricing Manager**. Change in Settings or `APP_DISPLAY_NAME`.

## Tests run vs blocked

**Run locally (no Shopify credentials required):**

```bash
npm test
npm run typecheck
```

**Blocked without credentials / plan verification:**

- Development-store checkout with live Function discount
- Full historical order import against a real shop
- End-to-end webhook delivery from Shopify

## Security notes

- Admin routes use `authenticate.admin`
- Webhooks use `authenticate.webhook` (HMAC)
- Compliance webhooks: `customers/data_request`, `customers/redact`, `shop/redact`
- Audit logs redact tokens/secrets
- Never accept a browser-supplied customer ID as proof of account ownership
- Function rejects untrusted discount percentages; only app metafield maps authorize bps

## License

See `LICENSE.md` from the Shopify app template.

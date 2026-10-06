# Wholesale access (Clay-like, automated)

This app is built to **replace Clay • B2B Wholesale + Clay • B2B Lock** with automation:

1. Customer applies (Forms)
2. Admin approves
3. Tier engine assigns pricing from spend + eligibility
4. App syncs **Shopify customer tags** so the theme shows wholesale prices and unlocks catalog
5. Optional Discount Function syncs checkout (when `PRICING_WRITES_ENABLED=true`)

## Tags written by the app

| Tag | Meaning |
| --- | --- |
| `vpm` | Managed by Volume Pricing Manager |
| `vpm-approved` | Business approved |
| `{TierName}` | e.g. `Wholesale`, `Distributor`, `Retailer` (Clay-compatible) |
| `vpm-tier-{slug}` | Stable tier slug |
| `vpm-pct-{N}` | Exact discount percent from the tier (theme prefers this over hardcoded 30/20/10) |

Configure under **Admin → Wholesale access**.

## Theme

- `snippets/mfg-wholesale-discount.liquid` — reads `vpm-pct-*` then falls back to Clay tag rates
- `snippets/vpm-lock-products.liquid` — lock prices/ATC until approved / tagged
- `snippets/clay-lock-products.liquid` — prefers VPM lock during migration

## Migration off Clay

1. Create tiers named to match your old Clay groups (Wholesale / Distributor / Retailer) with the correct %
2. Publish a VPM form; in Theme Editor replace Clay registration on Applications with the VPM form block + handle
3. Disable Clay Wholesale price embed when VPM tags are driving PDP
4. Disable Clay Lock once `vpm-lock-products` is in use
5. Run **Re-sync tags for all customers** after approving accounts
6. Keep worker running so tag + pricing jobs process

## Checkout vs storefront

- **Storefront prices** = tags + theme (works without Functions)
- **Checkout discounts** = Discount Function metafields (needs Plus for custom apps, extension deploy, `PRICING_WRITES_ENABLED`)

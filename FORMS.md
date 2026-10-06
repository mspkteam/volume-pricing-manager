# Application Forms

Publishable storefront forms for wholesale / contractor applications and general intake. Forms are **not** automatic tier assignment — approval updates eligibility; spend-based qualification still runs through the existing tier engine.

## Setup checklist

1. Deploy the app with the forms Prisma migration applied (`ApplicationForms`, `FormVersions`, `FormSubmissions`, `FormUploads`).
2. Confirm `[app_proxy]` in `shopify.app.toml`:
   - `url` = `${SHOPIFY_APP_URL}/proxy` (e.g. `https://volume-pricing-manager.vercel.app/proxy`)
   - `subpath` = `volume-pricing`
   - `prefix` = `apps`
3. Push / deploy so the theme extension `volume-pricing-form` is available in the Theme Editor.
4. (Optional but required for file fields) Configure private upload storage — see below.
5. In admin: **Forms → Create → Publish → Embed**, copy the handle, paste into the theme block setting.

## App proxy paths

| Storefront path | App route | Purpose |
| --- | --- | --- |
| `/apps/volume-pricing/forms/{handle}` | `proxy.forms.$handle` | GET published schema |
| `/apps/volume-pricing/forms/{handle}/submit` | `proxy.forms.$handle.submit` | POST answers + idempotency |
| `/apps/volume-pricing/forms/{handle}/upload` | `proxy.forms.$handle.upload` | POST multipart file |
| `/apps/volume-pricing/account/status` | `proxy.account.status` | GET customer application + tier + spend |

Shopify signs `logged_in_customer_id` on proxy query strings. After `authenticate.public.appProxy(request)`, read it from `URL.searchParams` — never invent customer identities from email alone.

## Theme embed

Theme Editor **cannot** dynamically list app forms. Merchants must paste the form handle into the block’s text setting. The block loads schema from the proxy and scopes CSS/JS per `block.id`.

## Uploads

Preferred on Vercel: create a **private** Blob store and connect it (adds `BLOB_READ_WRITE_TOKEN`).
The app auto-detects that token, or set `UPLOAD_STORAGE_PROVIDER=blob`.

Also supported:

- `UPLOAD_STORAGE_PROVIDER` = `blob` | `s3` | `r2` | `memory` | `dev`
- `UPLOAD_BUCKET`, `UPLOAD_ACCESS_KEY_ID`, `UPLOAD_SECRET_ACCESS_KEY` (S3/R2)
- For S3/R2 PUT gateways: `UPLOAD_PUT_BASE_URL`, `UPLOAD_GET_BASE_URL`, `UPLOAD_PUT_TOKEN`
- Local only: `memory`/`dev` (+ `ALLOW_DEV_UPLOADS=true` if needed)

Until configured, `uploadsConfigured()` is false and file fields show a setup message (forms without uploads still work).

## Wholesale publish rules

Forms with `purpose: WHOLESALE` require business mappings before publish:

- `applicant_email`
- `company_name`
- `company_address`

Condition references must resolve (no missing fields / cycles).

## Review vs pricing

- **Application status** — PENDING / NEEDS_INFORMATION / APPROVED / REJECTED / WITHDRAWN
- **Pricing sync status** — lives on `CustomerProfiles` after approval links a customer

Approving does **not** auto-grant the requested tier. Optional audited **starting-tier override** (projected volume) requires reason/expiry and is logged; recalculation still uses the tier engine.

## Rate limiting

In-memory rate limits protect proxy endpoints (`app/services/forms/rate-limit.ts`). Multi-instance production should swap for Redis.

## Admin routes

- `/app/forms` — list
- `/app/forms/new` — create
- `/app/forms/:id` — builder
- `/app/forms/:id/embed` — handle + theme steps
- `/app/forms/:id/submissions` — per-form list
- `/app/forms/:id/submissions/:submissionId` — detail + review
- `/app/applications` — cross-form inbox

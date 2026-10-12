# Application Forms

Publishable storefront forms for wholesale / contractor applications and general intake. Forms are **not** automatic tier assignment — approval updates eligibility; spend-based qualification still runs through the existing tier engine.

## Setup checklist

1. Deploy the app with the forms Prisma migration applied (`ApplicationForms`, `FormVersions`, `FormSubmissions`, `FormUploads`).
2. Confirm `[app_proxy]` in `shopify.app.toml`:
   - `url` = `${SHOPIFY_APP_URL}/proxy` (e.g. `https://volume-pricing-manager.vercel.app/proxy`)
   - `subpath` = `volume-pricing`
   - `prefix` = `apps`
3. Deploy the theme extension (`shopify app deploy`) so **App embeds → Volume Pricing** and the **Volume Pricing Form** block appear in the Theme Editor.
4. (Optional but required for file fields) Configure private upload storage — see below.
5. In admin: **Forms → Create → Publish → Embed**, copy the **Form ID**, enable the App embed, add the Form block, paste the Form ID.

## App proxy paths

| Storefront path | App route | Purpose |
| --- | --- | --- |
| `/apps/volume-pricing/forms/{idOrHandle}` | `proxy.forms.$handle` | GET published schema (Form ID or handle) |
| `/apps/volume-pricing/forms/{idOrHandle}/submit` | `proxy.forms.$handle.submit` | POST answers + idempotency |
| `/apps/volume-pricing/forms/{idOrHandle}/upload` | `proxy.forms.$handle.upload` | POST multipart file |
| `/apps/volume-pricing/account/status` | `proxy.account.status` | GET customer application + tier + spend |

Shopify signs `logged_in_customer_id` on app proxy query strings. After `authenticate.public.appProxy(request)`, read it from `URL.searchParams` — never invent customer identities from email alone.

## Theme embed (App embed + Form ID widget)

1. **App embed** (`blocks/app-embed.liquid`, target `body`) — Theme settings → App embeds → **Volume Pricing**. Loads the form runtime globally (like other apps).
2. **Form widget** (`blocks/application-form.liquid`, target `section`) — add to a page and paste **Form ID** from Forms → Embed (handle still works).
3. Optional HTML with embed on: `<div data-vpm-form data-form-id="FORM_ID"></div>` or `VPMForm.render('#el', { formId })`.

Theme Editor cannot dynamically list app forms; merchants paste the Form ID into the block setting.

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
- `/app/forms/:id/embed` — Form ID + App embed / widget steps
- `/app/forms/:id/submissions` — per-form list
- `/app/forms/:id/submissions/:submissionId` — detail + review
- `/app/applications` — cross-form inbox

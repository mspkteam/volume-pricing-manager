/**
 * Keep Shopify embedded session query params (shop, host, embedded, id_token, …)
 * when navigating or redirecting inside the admin app.
 * Dropping them causes authenticate.admin() to return HTTP 410 Gone.
 */

export function withEmbeddedSearch(path: string, search: string): string {
  if (!search || search === "?") return path;
  if (path.includes("?") || path.startsWith("?")) return path;
  return `${path}${search.startsWith("?") ? search : `?${search}`}`;
}

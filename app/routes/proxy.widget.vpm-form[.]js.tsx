import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
// Bundled into the server build so Vercel does not need the extensions/ folder at runtime.
import widgetJs from "../storefront-assets/vpm-form.js?raw";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Prefer signed app-proxy requests; still serve public client JS if signature is missing
  // (some theme preview contexts strip query params from script tags).
  try {
    await authenticate.public.appProxy(request);
  } catch {
    // Public widget source — safe to serve without a session.
  }

  return new Response(widgetJs, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
};

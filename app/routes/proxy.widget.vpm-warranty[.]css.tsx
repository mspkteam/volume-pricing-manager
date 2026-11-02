import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
// Bundled into the server build so Vercel does not need the extensions/ folder at runtime.
import widgetCss from "../storefront-assets/vpm-warranty.css?raw";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    await authenticate.public.appProxy(request);
  } catch {
    // Public widget CSS — safe to serve without a session.
  }

  return new Response(widgetCss, {
    headers: {
      "Content-Type": "text/css; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      "Access-Control-Allow-Origin": "*",
    },
  });
};

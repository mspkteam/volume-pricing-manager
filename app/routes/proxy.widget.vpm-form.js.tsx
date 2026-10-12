import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const WIDGET_PATH = join(
  process.cwd(),
  "extensions/volume-pricing-form/assets/vpm-form.js",
);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);

  const body = readFileSync(WIDGET_PATH, "utf8");
  return new Response(body, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
};

import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Link,
  Outlet,
  useLoaderData,
  useLocation,
  useNavigate,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NavMenu } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import { withEmbeddedSearch } from "../lib/embedded-nav";
import "../styles/admin.css";

declare module "@shopify/shopify-app-react-router/react" {
  export function AppProvider(props: {
    apiKey: string;
    children: React.ReactNode;
    embedded?: boolean;
  }): React.ReactElement;
}

import { AppProvider } from "@shopify/shopify-app-react-router/react";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);
  const apiKey = process.env.SHOPIFY_API_KEY || "";
  if (!apiKey) {
    console.warn("[vpm] SHOPIFY_API_KEY is empty — embedded NavMenu navigation may break");
  }
  return { apiKey };
};

function NavTo({ to, children, rel }: { to: string; children: React.ReactNode; rel?: string }) {
  const location = useLocation();
  return (
    <Link to={{ pathname: to, search: location.search }} rel={rel}>
      {children}
    </Link>
  );
}

/** Catch Polaris s-link / s-button navigations that drop shop/host (→ 410). */
function usePreserveEmbeddedClicks() {
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

      const path = event.composedPath() as EventTarget[];
      let href: string | null = null;
      for (const node of path) {
        if (!(node instanceof HTMLElement)) continue;
        const tag = node.tagName;
        if (tag === "S-LINK" || tag === "S-BUTTON" || tag === "A") {
          href = node.getAttribute("href");
          if (href) break;
        }
      }
      if (!href || !href.startsWith("/app")) return;
      if (href.includes("shop=") || href.includes("host=")) return;
      if (!location.search || location.search === "?") return;

      event.preventDefault();
      event.stopPropagation();
      const q = href.indexOf("?");
      const pathname = q >= 0 ? href.slice(0, q) : href;
      const extra = q >= 0 ? href.slice(q) : "";
      const next = withEmbeddedSearch(pathname + extra, location.search);
      const nq = next.indexOf("?");
      navigate({
        pathname: nq >= 0 ? next.slice(0, nq) : next,
        search: nq >= 0 ? next.slice(nq) : location.search,
      });
    }

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [location.search, navigate]);
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  usePreserveEmbeddedClicks();

  return (
    <AppProvider apiKey={apiKey} embedded>
      <NavMenu>
        <NavTo to="/app" rel="home">
          Home
        </NavTo>
        <NavTo to="/app/tiers">Tiers</NavTo>
        <NavTo to="/app/customers">Customers</NavTo>
        <NavTo to="/app/applications">Applications</NavTo>
        <NavTo to="/app/forms">Forms</NavTo>
        <NavTo to="/app/wholesale">Wholesale</NavTo>
        <NavTo to="/app/settings">Settings</NavTo>
      </NavMenu>
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

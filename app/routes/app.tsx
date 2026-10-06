import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, Outlet, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { NavMenu } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import "../styles/admin.css";

// AppProvider types are missing from the published package build in some versions;
// runtime export still exists — declare locally for typecheck.
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
  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
    displayName: process.env.APP_DISPLAY_NAME || "Volume Pricing Manager",
  };
};

export default function App() {
  const { apiKey, displayName } = useLoaderData<typeof loader>();

  return (
    <AppProvider apiKey={apiKey} embedded>
      <NavMenu>
        <Link to="/app" rel="home">
          {displayName}
        </Link>
        <Link to="/app/tiers">Tiers</Link>
        <Link to="/app/customers">Customers</Link>
        <Link to="/app/forms">Forms</Link>
        <Link to="/app/applications">Applications</Link>
        <Link to="/app/wholesale">Wholesale</Link>
        <Link to="/app/automation">Automation</Link>
        <Link to="/app/settings">Settings</Link>
        <Link to="/app/how-it-works">Help</Link>
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

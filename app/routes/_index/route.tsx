import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { login } from "../../shopify.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Volume Pricing Manager</h1>
        <p className={styles.text}>
          Automated customer pricing tiers from qualifying purchase spend — for HVAC and trade
          wholesale merchants.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Configurable tiers</strong>. Merchants define names, thresholds, discounts, and
            approval rules — no hardcoded Tier A/B/C.
          </li>
          <li>
            <strong>Rolling spend</strong>. Qualifying purchases drive upgrades, grace periods, and
            scheduled reviews.
          </li>
          <li>
            <strong>Checkout sync</strong>. Pricing status stays separate from tier assignment until
            Shopify Functions compatibility is verified.
          </li>
        </ul>
      </div>
    </div>
  );
}

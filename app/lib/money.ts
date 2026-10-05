/**
 * Currency-safe money helpers using integer minor units and Decimal.js.
 * Never use floating-point arithmetic for monetary values.
 */

import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type MoneyMinor = bigint;

/** Convert a shop-currency decimal string (e.g. "12.34") to minor units. */
export function toMinorUnits(amount: string | number | Decimal, currencyExponent = 2): MoneyMinor {
  const d = new Decimal(amount);
  const scaled = d.mul(new Decimal(10).pow(currencyExponent));
  return BigInt(scaled.toFixed(0, Decimal.ROUND_HALF_UP));
}

/** Convert minor units back to a decimal string for display/API. */
export function fromMinorUnits(minor: MoneyMinor | number | string, currencyExponent = 2): string {
  const d = new Decimal(minor.toString());
  return d.div(new Decimal(10).pow(currencyExponent)).toFixed(currencyExponent);
}

export function addMinor(a: MoneyMinor, b: MoneyMinor): MoneyMinor {
  return a + b;
}

export function subMinor(a: MoneyMinor, b: MoneyMinor): MoneyMinor {
  return a - b;
}

export function maxMinor(a: MoneyMinor, b: MoneyMinor): MoneyMinor {
  return a >= b ? a : b;
}

export function minMinor(a: MoneyMinor, b: MoneyMinor): MoneyMinor {
  return a <= b ? a : b;
}

export function clampNonNegative(minor: MoneyMinor): MoneyMinor {
  return minor < 0n ? 0n : minor;
}

/** Basis points: 1500 = 15.00% */
export function bpsToPercentString(bps: number): string {
  return new Decimal(bps).div(100).toFixed(2);
}

export function percentToBps(percent: number | string): number {
  const bps = new Decimal(percent).mul(100);
  if (!bps.isInteger() || bps.lt(0) || bps.gt(10000)) {
    throw new Error(`Invalid discount percent: ${percent}`);
  }
  return bps.toNumber();
}

export function formatMoney(
  minor: MoneyMinor,
  currencyCode: string,
  locale = "en-US",
  currencyExponent = 2,
): string {
  const amount = Number(fromMinorUnits(minor, currencyExponent));
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currencyCode,
    }).format(amount);
  } catch {
    return `${fromMinorUnits(minor, currencyExponent)} ${currencyCode}`;
  }
}

export { Decimal };

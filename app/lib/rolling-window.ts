/**
 * Rolling calendar-month window helpers in the shop timezone.
 *
 * Boundary rules:
 * - Window end is the start of "today" in shop TZ (exclusive upper bound for
 *   "through end of yesterday" semantics), OR inclusive through now depending
 *   on policy. Default: inclusive of current day end in shop TZ.
 * - Window start = same calendar day N months earlier at 00:00:00.000 shop TZ.
 * - Month-end clamping: Jan 31 minus 1 month → Jan 31 (same day when possible).
 *   Feb has no 31 → clamp to last day of February (handles leap years).
 * - Leap years: Feb 29 start only exists in leap years; otherwise clamp to Feb 28.
 */

export type SpendWindow = {
  start: Date;
  end: Date;
  periodMonths: number;
  timezone: string;
};

function partsInTz(date: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** Construct a Date representing local wall time in `timeZone` as an absolute UTC instant. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  ms: number,
  timeZone: string,
): Date {
  // Iteratively refine UTC guess using the timezone offset at that instant.
  let utc = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  for (let i = 0; i < 3; i++) {
    const asLocal = partsInTz(new Date(utc), timeZone);
    const wanted = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    const got = Date.UTC(
      asLocal.year,
      asLocal.month - 1,
      asLocal.day,
      asLocal.hour,
      asLocal.minute,
      asLocal.second,
      ms,
    );
    utc += wanted - got;
  }
  return new Date(utc);
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function subtractCalendarMonths(
  year: number,
  month: number,
  day: number,
  months: number,
): { year: number; month: number; day: number } {
  const total = year * 12 + (month - 1) - months;
  const y = Math.floor(total / 12);
  const m = (total % 12) + 1;
  const dim = daysInMonth(y, m);
  return { year: y, month: m, day: Math.min(day, dim) };
}

/**
 * Compute the rolling window for spend calculation.
 * Default: last `periodMonths` calendar months ending at end-of-today in shop TZ.
 * An order at `processedAt` qualifies when: start <= processedAt <= end.
 */
export function computeRollingWindow(
  now: Date,
  periodMonths: number,
  timezone: string,
): SpendWindow {
  if (periodMonths < 1 || periodMonths > 120) {
    throw new Error(`Invalid rolling period months: ${periodMonths}`);
  }
  const local = partsInTz(now, timezone);
  const end = zonedTimeToUtc(local.year, local.month, local.day, 23, 59, 59, 999, timezone);
  const startParts = subtractCalendarMonths(local.year, local.month, local.day, periodMonths);
  // Start is the same calendar day N months ago at 00:00:00.000 — orders on that
  // day are included. Example: on 2026-03-31 with 12 months → start 2025-03-31 00:00.
  // On 2026-03-31 minus 1 month → 2026-02-28 (or 29 in leap year).
  const start = zonedTimeToUtc(
    startParts.year,
    startParts.month,
    startParts.day,
    0,
    0,
    0,
    0,
    timezone,
  );
  return { start, end, periodMonths, timezone };
}

export function isWithinWindow(processedAt: Date, window: SpendWindow): boolean {
  return processedAt >= window.start && processedAt <= window.end;
}

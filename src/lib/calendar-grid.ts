import { addDays, getJstParts, jstDateKey, jstDayStart } from "./jst";
import type { SaleTiming } from "./sale-display";

export const MIN_CALENDAR_YEAR = 2020;
export const MAX_CALENDAR_YEAR = 2100;
export const CALENDAR_DAYS = 42; // 6 weeks x 7 days, always.
export const MAX_EVENTS_PER_DAY = 2;

export type YearMonth = { year: number; month: number }; // month: 1-12

export type CalendarDay = {
  key: string; // "YYYY-MM-DD" (JST)
  day: number;
  weekday: number; // 0 = Sunday
  start: Date; // 00:00 JST
  end: Date; // next day 00:00 JST (exclusive)
  inMonth: boolean;
  isToday: boolean;
};

export type CalendarCell<T> = CalendarDay & { events: T[] };

type SearchParamValue = string | string[] | undefined;

function parseIntegerParam(value: SearchParamValue): number | null {
  if (typeof value !== "string" || !/^\d{1,4}$/.test(value)) return null;
  return Number(value);
}

function isValidYearMonth({ year, month }: YearMonth): boolean {
  return (
    Number.isInteger(year) &&
    Number.isInteger(month) &&
    year >= MIN_CALENDAR_YEAR &&
    year <= MAX_CALENDAR_YEAR &&
    month >= 1 &&
    month <= 12
  );
}

export function currentJstYearMonth(now: Date): YearMonth {
  const { year, month } = getJstParts(now);
  return { year, month };
}

// Any missing, malformed, repeated or out-of-range value falls back to the
// current JST month.
export function resolveYearMonth(
  yearParam: SearchParamValue,
  monthParam: SearchParamValue,
  now: Date,
): YearMonth {
  const year = parseIntegerParam(yearParam);
  const month = parseIntegerParam(monthParam);
  if (year === null || month === null) return currentJstYearMonth(now);
  const candidate = { year, month };
  return isValidYearMonth(candidate) ? candidate : currentJstYearMonth(now);
}

// Returns null when the shifted month leaves the supported year range.
export function shiftMonth({ year, month }: YearMonth, delta: number): YearMonth | null {
  const index = year * 12 + (month - 1) + delta;
  const shifted = { year: Math.floor(index / 12), month: (index % 12) + 1 };
  return isValidYearMonth(shifted) ? shifted : null;
}

export function monthStart({ year, month }: YearMonth): Date {
  return jstDayStart(year, month, 1);
}

export function nextMonthStart({ year, month }: YearMonth): Date {
  return jstDayStart(year, month + 1, 1); // Date.UTC rolls month 13 over.
}

// Sunday on or before the 1st of the month, 00:00 JST.
export function gridStart(yearMonth: YearMonth): Date {
  const first = monthStart(yearMonth);
  return addDays(first, -getJstParts(first).weekday);
}

// Half-open query window [from, to) covering all 42 grid days.
export function calendarRange(yearMonth: YearMonth): { from: Date; to: Date } {
  const from = gridStart(yearMonth);
  return { from, to: addDays(from, CALENDAR_DAYS) };
}

export function buildCalendarDays(yearMonth: YearMonth, now: Date): CalendarDay[] {
  const start = gridStart(yearMonth);
  const todayKey = jstDateKey(now);
  return Array.from({ length: CALENDAR_DAYS }, (_, index) => {
    const dayStart = addDays(start, index);
    const { year, month, day, weekday } = getJstParts(dayStart);
    const key = jstDateKey(dayStart);
    return {
      key,
      day,
      weekday,
      start: dayStart,
      end: addDays(dayStart, 1),
      inMonth: year === yearMonth.year && month === yearMonth.month,
      isToday: key === todayKey,
    };
  });
}

// Same overlap rule for timed and date-only sales; endsAt is exclusive.
export function overlaps(sale: SaleTiming, from: Date, to: Date): boolean {
  return (
    new Date(sale.startsAt).getTime() < to.getTime() &&
    new Date(sale.endsAt).getTime() > from.getTime()
  );
}

export function assignEventsToDays<T extends SaleTiming>(
  days: readonly CalendarDay[],
  sales: readonly T[],
): CalendarCell<T>[] {
  return days.map((day) => ({
    ...day,
    events: sales.filter((sale) => overlaps(sale, day.start, day.end)),
  }));
}

export function splitVisibleEvents<T>(
  events: readonly T[],
  max: number = MAX_EVENTS_PER_DAY,
): { visible: T[]; hiddenCount: number } {
  return { visible: events.slice(0, max), hiddenCount: Math.max(0, events.length - max) };
}

// Sales overlapping the target month itself (not just the grid's
// neighbouring-month days).
export function filterMonthSales<T extends SaleTiming>(
  sales: readonly T[],
  yearMonth: YearMonth,
): T[] {
  const from = monthStart(yearMonth);
  const to = nextMonthStart(yearMonth);
  return sales.filter((sale) => overlaps(sale, from, to));
}

// null yearMonth means "current month" (plain /calendar).
export function calendarHref(yearMonth: YearMonth | null, retailerSlug?: string): string {
  const params = new URLSearchParams();
  if (yearMonth !== null) {
    params.set("year", String(yearMonth.year));
    params.set("month", String(yearMonth.month));
  }
  if (retailerSlug !== undefined) params.set("retailer", retailerSlug);
  const query = params.toString();
  return query === "" ? "/calendar" : `/calendar?${query}`;
}

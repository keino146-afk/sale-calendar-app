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
export function calendarHref(
  yearMonth: YearMonth | null,
  retailerSlug?: string,
  dayKey?: string,
): string {
  const params = new URLSearchParams();
  if (yearMonth !== null) {
    params.set("year", String(yearMonth.year));
    params.set("month", String(yearMonth.month));
    if (dayKey !== undefined) params.set("day", dayKey);
  }
  if (retailerSlug !== undefined) params.set("retailer", retailerSlug);
  const query = params.toString();
  return query === "" ? "/calendar" : `/calendar?${query}`;
}

// A valid "YYYY-MM-DD" inside the grid wins; otherwise JST today when it is
// in the grid; otherwise the 1st of the target month.
export function resolveSelectedDay(
  dayParam: SearchParamValue,
  days: readonly CalendarDay[],
): CalendarDay {
  if (typeof dayParam === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dayParam)) {
    const requested = days.find((day) => day.key === dayParam);
    if (requested !== undefined) return requested;
  }
  const today = days.find((day) => day.isToday);
  if (today !== undefined) return today;
  const firstOfMonth = days.find((day) => day.inMonth && day.day === 1);
  if (firstOfMonth === undefined) throw new Error("calendar grid has no first day");
  return firstOfMonth;
}

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

// "10月15日(木)"
export function formatDayHeading(day: CalendarDay): string {
  const { month } = getJstParts(day.start);
  return `${month}月${day.day}日(${WEEKDAYS_JA[day.weekday]})`;
}

export type WeekSegment<T> = {
  event: T;
  startColumn: number; // 0-6
  span: number; // 1-7
  lane: number; // 0 .. maxLanes-1
  continuesBefore: boolean;
  continuesAfter: boolean;
};

export type CalendarWeek<T> = {
  days: CalendarDay[];
  segments: WeekSegment<T>[];
  hiddenCounts: number[]; // per column, events that did not fit in a lane
};

// Splits each sale into one bar segment per week row and packs segments
// into at most `maxLanes` lanes. Overlap uses the same exclusive-end rule
// as assignEventsToDays, so bars always match the per-day assignment.
export function buildCalendarWeeks<T extends SaleTiming>(
  days: readonly CalendarDay[],
  sales: readonly T[],
  maxLanes: number = MAX_EVENTS_PER_DAY,
): CalendarWeek<T>[] {
  const weeks: CalendarWeek<T>[] = [];
  for (let offset = 0; offset < days.length; offset += 7) {
    const weekDays = days.slice(offset, offset + 7);
    const candidates: Omit<WeekSegment<T>, "lane">[] = [];
    for (const sale of sales) {
      const columns = weekDays.flatMap((day, column) =>
        overlaps(sale, day.start, day.end) ? [column] : [],
      );
      if (columns.length === 0) continue;
      const first = columns[0];
      const last = columns[columns.length - 1];
      candidates.push({
        event: sale,
        startColumn: first,
        span: last - first + 1,
        continuesBefore:
          first === 0 && new Date(sale.startsAt).getTime() < weekDays[0].start.getTime(),
        continuesAfter:
          last === weekDays.length - 1 &&
          new Date(sale.endsAt).getTime() > weekDays[weekDays.length - 1].end.getTime(),
      });
    }

    // Earlier start first, then longer bars, then input order (stable sort).
    candidates.sort((a, b) => a.startColumn - b.startColumn || b.span - a.span);

    const laneEnds: number[] = []; // first free column per lane
    const segments: WeekSegment<T>[] = [];
    const hiddenCounts = Array.from({ length: weekDays.length }, () => 0);
    for (const candidate of candidates) {
      const lane = laneEnds.findIndex((end) => end <= candidate.startColumn);
      const target = lane === -1 ? laneEnds.length : lane;
      if (target < maxLanes) {
        laneEnds[target] = candidate.startColumn + candidate.span;
        segments.push({ ...candidate, lane: target });
      } else {
        for (let column = candidate.startColumn; column < candidate.startColumn + candidate.span; column++) {
          hiddenCounts[column] += 1;
        }
      }
    }
    weeks.push({ days: weekDays, segments, hiddenCounts });
  }
  return weeks;
}

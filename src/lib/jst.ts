// Japan Standard Time helpers. JST is a fixed UTC+9 offset (no DST since
// 1951), so all calculations are plain epoch arithmetic and never depend on
// the process time zone.

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

export type JstParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
};

export function getJstParts(date: Date): JstParts {
  const shifted = new Date(date.getTime() + JST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

// 00:00 JST of the given calendar day, as an absolute instant.
// Out-of-range days/months roll over like Date.UTC (e.g. day 0, month 13).
export function jstDayStart(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day) - JST_OFFSET_MS);
}

export function startOfJstDay(date: Date): Date {
  const { year, month, day } = getJstParts(date);
  return jstDayStart(year, month, day);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * DAY_MS);
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

export function jstDateKey(date: Date): string {
  const { year, month, day } = getJstParts(date);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

// "11/1(日)"
export function formatJstMonthDayWeekday(date: Date): string {
  const { month, day, weekday } = getJstParts(date);
  return `${month}/${day}(${WEEKDAYS_JA[weekday]})`;
}

// "11/1 00:30"
export function formatJstMonthDayTime(date: Date): string {
  const { month, day, hour, minute } = getJstParts(date);
  return `${month}/${day} ${pad2(hour)}:${pad2(minute)}`;
}

// "2026/11/1"
export function formatJstFullDate(date: Date): string {
  const { year, month, day } = getJstParts(date);
  return `${year}/${month}/${day}`;
}

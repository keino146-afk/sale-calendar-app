// Shared helpers for reading explicit Japanese dates. Each source adapter
// keeps its own grammar (what counts as a period); these only turn stated
// values into instants and count date mentions. Nothing here infers a value.

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const MINUTE_MS = 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

// Optional weekday after a date, e.g. （金） or (月・祝), as it reads after NFKC.
export const WEEKDAY = String.raw`(?:\([月火水木金土日](?:・祝)?\))?`;

// The instant of a stated Asia/Tokyo wall-clock time, or null when the values
// do not form a real date and time. Independent of the system time zone.
export function jstInstant(year: number, month: number, day: number, hour = 0, minute = 0): Date | null {
  if (month < 1 || month > 12 || day < 1 || hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return new Date(utc - JST_OFFSET_MS);
}

// Every "M月D日" in the text, with or without a year: used to notice dates
// that are not part of a recognised period.
export function countMonthDayMentions(text: string): number {
  return [...text.matchAll(/\d{1,2}月\d{1,2}日/gu)].length;
}

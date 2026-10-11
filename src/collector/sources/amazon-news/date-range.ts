// Strict extraction of an explicit Japanese sale period, e.g.
//   2026年11月6日（金）9時から2026年11月9日（月）23時59分まで
// Both ends need a year, month, day and hour; the end also needs minutes,
// because "23時59分まで" is an inclusive minute and becomes the exclusive end
// 2026-11-10 00:00. Times are Asia/Tokyo. Nothing is inferred: no year from
// the publication date, no "this weekend", no "3 days". A missing, partial,
// impossible or second (different) period means no period at all.

export type SaleDateRange = { startsAt: Date; endsAt: Date; text: string };

export type DateRangeResult =
  | { ok: true; range: SaleDateRange }
  | { ok: false; reason: "no_date_range" | "ambiguous_date_range" | "invalid_date" };

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

// After NFKC, full-width digits and brackets are ASCII.
const WEEKDAY = String.raw`(?:\([月火水木金土日](?:・祝)?\))?`;
const DATE = String.raw`(\d{4})年(\d{1,2})月(\d{1,2})日${WEEKDAY}`;
const RANGE = new RegExp(
  String.raw`${DATE}\s*(\d{1,2})時(?:(\d{1,2})分)?\s*から\s*${DATE}\s*(\d{1,2})時(\d{1,2})分\s*まで`,
  "gu",
);
// Any month-day mention, with or without a year: used to detect stray dates.
const MONTH_DAY = /\d{1,2}月\d{1,2}日/gu;

function jst(year: number, month: number, day: number, hour: number, minute: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59) return null;
  const utc = Date.UTC(year, month - 1, day, hour, minute);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return new Date(utc - JST_OFFSET_MS);
}

type TextScan = { ranges: SaleDateRange[]; invalid: boolean; strayDates: boolean };

function scan(raw: string): TextScan {
  const text = raw.normalize("NFKC");
  const ranges: SaleDateRange[] = [];
  let invalid = false;
  for (const match of text.matchAll(RANGE)) {
    const [y1, mo1, d1, h1, mi1, y2, mo2, d2, h2, mi2] = match.slice(1, 11).map((part) => Number(part ?? 0));
    const startsAt = jst(y1, mo1, d1, h1, mi1);
    const lastMinute = jst(y2, mo2, d2, h2, mi2);
    if (startsAt === null || lastMinute === null) {
      invalid = true;
      continue;
    }
    ranges.push({ startsAt, endsAt: new Date(lastMinute.getTime() + MINUTE_MS), text: match[0] });
  }
  // Each range mentions exactly two dates; any other date is unexplained.
  const dateMentions = [...text.matchAll(MONTH_DAY)].length;
  const rangeMatches = [...text.matchAll(RANGE)].length;
  return { ranges, invalid, strayDates: dateMentions !== rangeMatches * 2 };
}

// Looks at every given text (e.g. title and description) together.
export function extractSaleDateRange(texts: (string | null)[]): DateRangeResult {
  const scans = texts.filter((text): text is string => text !== null).map(scan);
  if (scans.some((s) => s.invalid)) return { ok: false, reason: "invalid_date" };

  const ranges = scans.flatMap((s) => s.ranges);
  const distinct = new Set(ranges.map((r) => `${r.startsAt.getTime()}-${r.endsAt.getTime()}`));
  if (distinct.size > 1 || scans.some((s) => s.strayDates)) {
    return { ok: false, reason: ranges.length === 0 ? "no_date_range" : "ambiguous_date_range" };
  }
  if (ranges.length === 0) return { ok: false, reason: "no_date_range" };
  return { ok: true, range: ranges[0] };
}

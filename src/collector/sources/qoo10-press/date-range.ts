import type { ExtractedPeriod } from "../../feed-candidate";
import { countMonthDayMentions, DAY_MS, jstInstant, MINUTE_MS, WEEKDAY } from "../../jp-date";

// Strict extraction of one explicit sale period from a Qoo10 press release
// (Asia/Tokyo). Two precisions are accepted, never mixed:
//   date and time on both ends   2027年2月1日（月）17:00〜2月10日（水）23:59
//     -> the end minute is inclusive: ends 2027-02-11 00:00 exclusive
//   dates only on both ends      2027年2月1日から2月10日まで
//     -> date-only: 2/1 00:00 to 2/11 00:00 (the day after the last day)
// The start must state its year. The end may omit it only inside the same
// range (SAME_RANGE_YEAR_CARRY): it then takes the start's year, and if that
// would put the end before the start the period is rejected; a next year is
// never guessed. Nothing comes from the publication date. A missing, partial,
// mixed, impossible or second (different) period, or any other date in the
// text, means no period.

export type Qoo10DateRangeResult =
  | { ok: true; range: ExtractedPeriod }
  | {
      ok: false;
      reason:
        | "no_date_range"
        | "incomplete_date"
        | "mixed_precision"
        | "year_boundary"
        | "ambiguous_date_range"
        | "invalid_date";
    };

type Failure = Extract<Qoo10DateRangeResult, { ok: false }>["reason"];

// After NFKC: full-width digits, colon, brackets and "～" are ASCII.
const POINT = String.raw`(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日${WEEKDAY}(?:\s*(\d{1,2})(?:時(?:(\d{1,2})分)?|:(\d{2})))?`;
const RANGE = new RegExp(String.raw`${POINT}\s*(?:から|より|〜|~|-)\s*${POINT}(?:\s*まで)?`, "gu");

type Point = { year?: number; month: number; day: number; hour?: number; minute?: number };

function point(parts: (string | undefined)[]): Point {
  const [year, month, day, hour, kanjiMinute, colonMinute] = parts;
  const minute = kanjiMinute ?? colonMinute;
  return {
    year: year === undefined ? undefined : Number(year),
    month: Number(month),
    day: Number(day),
    hour: hour === undefined ? undefined : Number(hour),
    // Stated minutes only: "17時" has none (a start then means 17:00; an end
    // without minutes is rejected).
    minute: minute === undefined ? undefined : Number(minute),
  };
}

function readRange(match: RegExpMatchArray): ExtractedPeriod | Failure {
  const start = point(match.slice(1, 7));
  const end = point(match.slice(7, 13));
  if (start.year === undefined) return "incomplete_date";
  const endYear = end.year ?? start.year;

  const startTimed = start.hour !== undefined;
  const endTimed = end.hour !== undefined;
  if (startTimed !== endTimed) return "mixed_precision";

  let startsAt: Date | null;
  let endsAt: Date | null;
  if (!startTimed) {
    startsAt = jstInstant(start.year, start.month, start.day);
    const lastDay = jstInstant(endYear, end.month, end.day);
    endsAt = lastDay === null ? null : new Date(lastDay.getTime() + DAY_MS);
  } else {
    // An end time needs its minute: "23時まで" could mean 23:00 or 23:59.
    if (end.minute === undefined) return "incomplete_date";
    startsAt = jstInstant(start.year, start.month, start.day, start.hour, start.minute ?? 0);
    const lastMinute = jstInstant(endYear, end.month, end.day, end.hour, end.minute);
    endsAt = lastMinute === null ? null : new Date(lastMinute.getTime() + MINUTE_MS);
  }
  if (startsAt === null || endsAt === null) return "invalid_date";
  if (end.year === undefined && endsAt.getTime() <= startsAt.getTime()) return "year_boundary";
  return { startsAt, endsAt, isDateOnly: !startTimed, text: match[0] };
}

type TextScan = { ranges: ExtractedPeriod[]; failure: Failure | null; strayDates: boolean };

function scan(raw: string): TextScan {
  const text = raw.normalize("NFKC");
  const matches = [...text.matchAll(RANGE)];
  const ranges: ExtractedPeriod[] = [];
  let failure: Failure | null = null;
  for (const match of matches) {
    const result = readRange(match);
    if (typeof result === "string") failure ??= result;
    else ranges.push(result);
  }
  // Each range mentions exactly two dates; any other date is unexplained.
  return { ranges, failure, strayDates: countMonthDayMentions(text) !== matches.length * 2 };
}

// Looks at every given text (e.g. title and description) together.
export function extractQoo10SaleDateRange(texts: (string | null)[]): Qoo10DateRangeResult {
  const scans = texts.filter((text): text is string => text !== null).map(scan);
  const failure = scans.find((s) => s.failure !== null)?.failure;
  if (failure) return { ok: false, reason: failure };

  const ranges = scans.flatMap((s) => s.ranges);
  const distinct = new Set(ranges.map((r) => `${r.startsAt.getTime()}-${r.endsAt.getTime()}-${r.isDateOnly}`));
  if (distinct.size > 1 || scans.some((s) => s.strayDates)) {
    return { ok: false, reason: ranges.length === 0 ? "no_date_range" : "ambiguous_date_range" };
  }
  if (ranges.length === 0) return { ok: false, reason: "no_date_range" };
  return { ok: true, range: ranges[0] };
}

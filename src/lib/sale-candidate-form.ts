import { DAY_MS, getJstParts, JST_OFFSET_MS, jstDateKey } from "./jst";

// Parsing and validation for the admin "new sale candidate" form. Mirrors the
// sale_events constraints (the database stays the final authority):
//   title: 1-200 characters after NFKC and removing all whitespace
//   description: optional, at most 5000 characters
//   source_url: https:// only, at most 2048 characters
//   ends_at > starts_at (ends_at is exclusive)
// All dates and times are entered and interpreted as Asia/Tokyo.

export const PERIOD_MODES = ["date", "datetime"] as const;
export type PeriodMode = (typeof PERIOD_MODES)[number];

export function parsePeriodMode(value: string | string[] | undefined): PeriodMode {
  return value === "datetime" ? "datetime" : "date";
}

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 5000;
export const SOURCE_URL_MAX_LENGTH = 2048;
const MIN_YEAR = 2020;
const MAX_YEAR = 2100;

export type FormErrorCode =
  | "invalid_input"
  | "retailer"
  | "title"
  | "description"
  | "source_url"
  | "source_domain"
  | "checked_at"
  | "period";

export type SaleCandidateInput = {
  retailerId: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  isDateOnly: boolean;
  sourceUrl: string;
  sourceCheckedAt: Date;
};

type Result = { ok: true; value: SaleCandidateInput } | { ok: false; error: FormErrorCode };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(formData: FormData, name: string): string | null {
  const value = formData.get(name);
  return typeof value === "string" ? value : null;
}

function codePointLength(value: string): number {
  return [...value].length;
}

export function isValidTitle(title: string): boolean {
  const stripped = title.normalize("NFKC").replace(/\s+/gu, "");
  const length = codePointLength(stripped);
  return length >= 1 && length <= TITLE_MAX_LENGTH;
}

// Absolute https URL without credentials, an explicit port, whitespace or
// control characters.
export function parseSourceUrl(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || value.length > SOURCE_URL_MAX_LENGTH) return null;
  if (/[\s\p{Cc}]/u.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (!value.toLowerCase().startsWith("https://")) return null;
  // URL drops a default ":443", so also look at the authority as written.
  if (url.port !== "" || /^https:\/\/[^/?#]*:/i.test(value)) return null;
  return value;
}

// The source must be on the retailer's official domain: the official host
// without a leading "www." or any of its subdomains.
export function isOnOfficialDomain(sourceUrl: string, officialBaseUrl: string): boolean {
  let source: URL;
  let official: URL;
  try {
    source = new URL(sourceUrl);
    official = new URL(officialBaseUrl);
  } catch {
    return false;
  }
  const base = official.hostname.toLowerCase().replace(/^www\./, "");
  const host = source.hostname.toLowerCase();
  return host === base || host.endsWith(`.${base}`);
}

function validYearMonthDay(year: number, month: number, day: number): boolean {
  if (year < MIN_YEAR || year > MAX_YEAR || month < 1 || month > 12 || day < 1) return false;
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCMonth() === month - 1 && check.getUTCDate() === day;
}

// "YYYY-MM-DD" as JST midnight, or null.
export function parseJstDate(raw: string | null): { year: number; month: number; day: number } | null {
  const match = raw?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return validYearMonthDay(year, month, day) ? { year, month, day } : null;
}

function jstMidnight({ year, month, day }: { year: number; month: number; day: number }): Date {
  return new Date(Date.UTC(year, month - 1, day) - JST_OFFSET_MS);
}

// "YYYY-MM-DDTHH:MM" (optionally ":SS") from datetime-local, read as JST.
export function parseJstDateTime(raw: string | null): Date | null {
  const match = raw?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  if (!validYearMonthDay(year, month, day) || hour > 23 || minute > 59 || second > 59) return null;
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - JST_OFFSET_MS);
}

export function parseSaleCandidateForm(formData: FormData, mode: PeriodMode): Result {
  const retailerId = text(formData, "retailerId");
  if (retailerId === null || !UUID_PATTERN.test(retailerId)) return { ok: false, error: "retailer" };

  const content = parseSaleContentForm(formData, mode);
  return content.ok ? { ok: true, value: { retailerId, ...content.value } } : content;
}

// The content fields shared by registration and editing (everything except
// the retailer, which an edit never changes).
export type SaleContentInput = Omit<SaleCandidateInput, "retailerId">;

type ContentResult = { ok: true; value: SaleContentInput } | { ok: false; error: FormErrorCode };

export function parseSaleContentForm(formData: FormData, mode: PeriodMode): ContentResult {
  const rawTitle = text(formData, "title");
  if (rawTitle === null || !isValidTitle(rawTitle)) return { ok: false, error: "title" };
  const title = rawTitle.trim();

  const rawDescription = text(formData, "description") ?? "";
  const trimmedDescription = rawDescription.trim();
  if (codePointLength(trimmedDescription) > DESCRIPTION_MAX_LENGTH) return { ok: false, error: "description" };
  const description = trimmedDescription === "" ? null : trimmedDescription;

  const sourceUrl = parseSourceUrl(text(formData, "sourceUrl") ?? "");
  if (sourceUrl === null) return { ok: false, error: "source_url" };

  const sourceCheckedAt = parseJstDateTime(text(formData, "sourceCheckedAt"));
  if (sourceCheckedAt === null) return { ok: false, error: "checked_at" };

  let startsAt: Date;
  let endsAt: Date;
  if (mode === "date") {
    const start = parseJstDate(text(formData, "startDate"));
    const lastDay = parseJstDate(text(formData, "endDate"));
    if (start === null || lastDay === null) return { ok: false, error: "period" };
    startsAt = jstMidnight(start);
    // The entered end date is inclusive; store the next day 00:00 JST.
    endsAt = new Date(jstMidnight(lastDay).getTime() + DAY_MS);
  } else {
    const start = parseJstDateTime(text(formData, "startsAt"));
    const end = parseJstDateTime(text(formData, "endsAt"));
    if (start === null || end === null) return { ok: false, error: "period" };
    startsAt = start;
    endsAt = end;
  }
  if (endsAt.getTime() <= startsAt.getTime()) return { ok: false, error: "period" };

  return {
    ok: true,
    value: {
      title,
      description,
      startsAt,
      endsAt,
      isDateOnly: mode === "date",
      sourceUrl,
      sourceCheckedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// Form defaults (e.g. prefilled from a collection candidate). These are only
// starting values for the admin to check; submission is validated as usual.

export type SaleFormDefaults = {
  retailerId: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  startsAt: string;
  endsAt: string;
  sourceUrl: string;
  sourceCheckedAt: string;
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// datetime-local value ("YYYY-MM-DDTHH:MM") in JST.
export function toJstDateTimeLocal(date: Date): string {
  const { year, month, day, hour, minute } = getJstParts(date);
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
}

// Date fields use the inclusive last day: the instant just before the
// exclusive end (so 10/14 00:00 -> 10/13, and 23:59 stays the same day).
export function saleFormDefaultsFromPeriod(input: {
  retailerId: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  sourceUrl: string;
  sourceCheckedAt: Date;
}): SaleFormDefaults {
  return {
    retailerId: input.retailerId,
    title: input.title,
    description: input.description ?? "",
    startDate: jstDateKey(input.startsAt),
    endDate: jstDateKey(new Date(input.endsAt.getTime() - 1)),
    startsAt: toJstDateTimeLocal(input.startsAt),
    endsAt: toJstDateTimeLocal(input.endsAt),
    sourceUrl: input.sourceUrl,
    sourceCheckedAt: toJstDateTimeLocal(input.sourceCheckedAt),
  };
}

// Form defaults for "このセールを元に作成" (Phase 6Q): a new sale prefilled from
// an existing one. The input type names the only fields that may be copied,
// so the source's id, status, timestamps, version (updated_at) and audit
// data cannot reach the form. The copy policy:
//   - title, description, source URL and the period type (date only or
//     with times) are copied;
//   - the retailer is mapped by slug to an active retailer's id, and left
//     unselected when the source's retailer is no longer active;
//   - the period is left empty: the new dates must come from the official
//     page, never from the previous sale;
//   - the checked-at time is `now`, as on a blank form (the copied URL has
//     not been checked for the new sale yet).
// The values are only a starting point; the submission goes through the
// normal create action and its validation.
export type PreviousSaleSource = {
  title: string;
  description: string | null;
  isDateOnly: boolean;
  sourceUrl: string;
  retailer: { slug: string };
};

export function saleFormDefaultsFromPreviousSale(
  source: PreviousSaleSource,
  activeRetailers: readonly { id: string; slug: string }[],
  now: Date,
): { defaults: SaleFormDefaults; mode: PeriodMode } {
  const retailer = activeRetailers.find((candidate) => candidate.slug === source.retailer.slug);
  return {
    defaults: {
      retailerId: retailer?.id ?? "",
      title: source.title,
      description: source.description ?? "",
      startDate: "",
      endDate: "",
      startsAt: "",
      endsAt: "",
      sourceUrl: source.sourceUrl,
      sourceCheckedAt: toJstDateTimeLocal(now),
    },
    mode: source.isDateOnly ? "date" : "datetime",
  };
}

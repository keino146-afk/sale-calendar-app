import { addDays, DAY_MS, formatJstDateTime, formatJstFullDate, JST_OFFSET_MS, startOfJstDay } from "./jst";
import { parseInstantMicros, PUSH_NOTIFICATION_KINDS, type PushNotificationKind } from "./push-notification-schedule";

// The title and body of one automatic push, for the kinds of one group from
// groupSendablePushNotifications (only the kinds still sendable). Pure: no
// clock, no database, no network, no sending. Whether to send is not decided
// here; withinBudget only reports whether the body fits the length asked for.
//
// Dates are JST as on public pages: formatJstDateTime for a timed sale (the
// end shown as the last running minute, endsAt - 1 ms) and formatJstFullDate
// for a date-only sale (the last day, the day before the exclusive end).

export type PushContentSale = {
  retailerName: string;
  title: string;
  startsAt: string;
  endsAt: string;
  isDateOnly: boolean;
};

export type PushContentOptions = {
  // Upper bound of the body, in grapheme clusters. Left out: no shortening
  // and no length check (withinBudget is then null).
  maxBodyGraphemes?: number;
};

export type PushContentError =
  | "invalid-kinds"
  | "invalid-retailer-name"
  | "invalid-sale-title"
  | "invalid-starts-at"
  | "invalid-ends-at"
  | "ends-not-after-starts"
  | "invalid-is-date-only"
  | "date-only-not-midnight"
  | "invalid-max-body-graphemes";

export type PushContentResult =
  | {
      ok: true;
      title: string;
      body: string;
      // The sale title was shortened (with "…") to fit maxBodyGraphemes.
      truncated: boolean;
      // true: fits maxBodyGraphemes. false: does not fit even with the sale
      // title shortened; the full body is returned and must not be taken as
      // ready to send. null: no maxBodyGraphemes given, nothing checked.
      withinBudget: boolean | null;
    }
  | { ok: false; error: PushContentError };

const ELLIPSIS = "…";
const JST_OFFSET_US = JST_OFFSET_MS * 1000;
const DAY_US = DAY_MS * 1000;
const END_KINDS: readonly PushNotificationKind[] = ["one-day-before-end", "two-hours-before-end"];

// Line breaks and tabs become spaces; control characters, bidirectional
// controls and invisible spacing characters (ZWSP, word joiner, BOM) go;
// whitespace runs (full-width spaces included) become one space. Other
// format characters stay: ZWJ, ZWNJ and tag characters are parts of emoji.
// Lone surrogates become U+FFFD. No Unicode normalization.
export function sanitizePushText(value: string): string {
  return value
    .toWellFormed()
    .replace(/\r\n|[\r\n\t\u0085\u2028\u2029]/g, " ")
    .replace(/[\p{Cc}\p{Bidi_Control}\u200B\u2060\uFEFF]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

type Parts = { retailer: string; sale: string; start: string; end: string };

const TITLES = {
  "new-sale": "新しいセール情報",
  "one-day-before-start": "まもなくセール開始",
  "at-start": "セール開始",
  "one-day-before-end": "セール終了が近づいています",
  "two-hours-before-end": "まもなくセール終了",
} satisfies Record<PushNotificationKind, string>;

type Template = "new-sale" | "one-day-before-start" | "at-start" | "at-start-with-end" | "end";

function renderBody(template: Template, { retailer, sale, start, end }: Parts): string {
  const name = `${retailer}「${sale}」`;
  switch (template) {
    case "new-sale":
      return `${name}の開催期間は${start}〜${end}です。`;
    case "one-day-before-start":
      return `${name}は${start}から開催予定です。`;
    case "at-start":
      return `${name}開催中！`;
    case "at-start-with-end":
      return `${name}開催中！終了は${end}です。`;
    case "end":
      return `${name}は${end}までです。`;
  }
}

// new-sale wins; at-start with an end notice adds the end; otherwise the
// first kind in PUSH_NOTIFICATION_KINDS order.
function selectTemplate(kinds: ReadonlySet<PushNotificationKind>): { kind: PushNotificationKind; template: Template } {
  if (kinds.has("new-sale")) return { kind: "new-sale", template: "new-sale" };
  if (kinds.has("at-start")) {
    const withEnd = END_KINDS.some((kind) => kinds.has(kind));
    return { kind: "at-start", template: withEnd ? "at-start-with-end" : "at-start" };
  }
  const kind = PUSH_NOTIFICATION_KINDS.find((candidate) => kinds.has(candidate))!;
  return { kind, template: kind === "one-day-before-start" ? "one-day-before-start" : "end" };
}

function graphemes(value: string): string[] {
  const segmenter = new Intl.Segmenter("ja", { granularity: "grapheme" });
  return Array.from(segmenter.segment(value), (part) => part.segment);
}

function validKinds(kinds: readonly PushNotificationKind[]): ReadonlySet<PushNotificationKind> | null {
  if (!Array.isArray(kinds) || kinds.length === 0) return null;
  const set = new Set(kinds);
  if (set.size !== kinds.length) return null;
  for (const kind of set) if (!(PUSH_NOTIFICATION_KINDS as readonly string[]).includes(kind)) return null;
  return set;
}

function isJstMidnightUs(us: number): boolean {
  return (us + JST_OFFSET_US) % DAY_US === 0;
}

export function buildPushNotificationContent(
  kinds: readonly PushNotificationKind[],
  sale: PushContentSale,
  options: PushContentOptions = {},
): PushContentResult {
  const kindSet = validKinds(kinds);
  if (kindSet === null) return { ok: false, error: "invalid-kinds" };

  const max = options.maxBodyGraphemes;
  if (max !== undefined && !(Number.isSafeInteger(max) && max > 0)) {
    return { ok: false, error: "invalid-max-body-graphemes" };
  }

  const retailer = typeof sale.retailerName === "string" ? sanitizePushText(sale.retailerName) : "";
  if (retailer === "") return { ok: false, error: "invalid-retailer-name" };
  const saleTitle = typeof sale.title === "string" ? sanitizePushText(sale.title) : "";
  if (saleTitle === "") return { ok: false, error: "invalid-sale-title" };

  const startUs = typeof sale.startsAt === "string" ? parseInstantMicros(sale.startsAt) : null;
  if (startUs === null) return { ok: false, error: "invalid-starts-at" };
  const endUs = typeof sale.endsAt === "string" ? parseInstantMicros(sale.endsAt) : null;
  if (endUs === null) return { ok: false, error: "invalid-ends-at" };
  if (endUs <= startUs) return { ok: false, error: "ends-not-after-starts" };
  if (typeof sale.isDateOnly !== "boolean") return { ok: false, error: "invalid-is-date-only" };

  // Displayed at the millisecond, like new Date(...) on public pages.
  const startDate = new Date(Math.floor(startUs / 1000));
  const endMs = Math.floor(endUs / 1000);
  let start: string;
  let end: string;
  if (sale.isDateOnly) {
    if (!isJstMidnightUs(startUs) || !isJstMidnightUs(endUs)) return { ok: false, error: "date-only-not-midnight" };
    start = formatJstFullDate(startDate);
    end = formatJstFullDate(addDays(startOfJstDay(new Date(endMs)), -1));
  } else {
    start = formatJstDateTime(startDate);
    end = formatJstDateTime(new Date(endMs - 1));
  }

  const { kind, template } = selectTemplate(kindSet);
  const title = TITLES[kind];
  const parts: Parts = { retailer, sale: saleTitle, start, end };
  const body = renderBody(template, parts);
  if (max === undefined) return { ok: true, title, body, truncated: false, withinBudget: null };

  const bodyLength = graphemes(body).length;
  if (bodyLength <= max) return { ok: true, title, body, truncated: false, withinBudget: true };

  // Shorten the sale title only, keeping at least one grapheme before "…".
  const saleGraphemes = graphemes(saleTitle);
  const fixedLength = bodyLength - saleGraphemes.length;
  for (let keep = Math.min(max - fixedLength - 1, saleGraphemes.length - 1); keep >= 1; keep--) {
    const shortened = renderBody(template, { ...parts, sale: saleGraphemes.slice(0, keep).join("") + ELLIPSIS });
    // Checked on the whole body: a grapheme can span the quote marks.
    if (graphemes(shortened).length <= max) {
      return { ok: true, title, body: shortened, truncated: true, withinBudget: true };
    }
  }
  return { ok: true, title, body, truncated: false, withinBudget: false };
}

import { DAY_MS } from "./jst";

// When each automatic push for a published sale is due, until when it may
// still be sent, and which due ones go out together. Pure calculation from
// absolute instants: no clock (now is always passed in), no database, no
// network, no sending.
//
// Like the rest of the app, times are absolute instants and endsAt is the
// exclusive end (for a date-only sale, 00:00 JST of the day after the last
// day). "N days before" is N × 24 hours, which in JST (fixed UTC+9, no DST)
// is also the same clock time N calendar days earlier.
//
// Instants here are microseconds since the Unix epoch as safe integers
// (the precision of Postgres timestamptz), never a Date: a Date keeps only
// milliseconds, so two times 1 µs apart would compare equal. Every value is
// checked with Number.isSafeInteger; anything outside fails, never rounds.
//
// What this does NOT do: remember what was sent. Calling it again returns the
// same due notifications, so never resending (after accepted, unknown,
// expired or cancelled, or after the sale is edited) is the job of the
// persistent delivery state that will call this, not of this module.

export const PUSH_NOTIFICATION_KINDS = [
  "new-sale",
  "three-days-before-start",
  "one-day-before-start",
  "at-start",
  "one-day-before-end",
  "three-hours-before-end",
  "one-hour-before-end",
] as const;

export type PushNotificationKind = (typeof PUSH_NOTIFICATION_KINDS)[number];

const MS_US = 1000;
const MINUTE_US = 60 * 1000 * MS_US;
const HOUR_US = 60 * MINUTE_US;
const DAY_US = DAY_MS * MS_US;

// How long after its due time each kind may still be sent, in microseconds.
// new-sale and at-start are also cut off at the end of the sale (see
// schedulePushNotifications).
export const PUSH_NOTIFICATION_GRACE_US: Record<PushNotificationKind, number> = {
  "new-sale": 24 * HOUR_US,
  "three-days-before-start": HOUR_US,
  "one-day-before-start": HOUR_US,
  "at-start": 15 * MINUTE_US,
  "one-day-before-end": HOUR_US,
  "three-hours-before-end": 15 * MINUTE_US,
  "one-hour-before-end": 5 * MINUTE_US,
};

export type PushScheduleSale = {
  id: string;
  startsAt: string;
  endsAt: string;
  // When the sale was first published (published_at), never an edit time.
  publishedAt: string;
};

export type ScheduledPushNotification = {
  saleId: string;
  kind: PushNotificationKind;
  dueAtUs: number;
  // Exclusive: at deadlineAtUs the notification has expired.
  deadlineAtUs: number;
};

export type PushScheduleError =
  | "invalid-sale-id"
  | "invalid-starts-at"
  | "invalid-ends-at"
  | "invalid-published-at"
  | "ends-not-after-starts"
  | "instant-out-of-range";

export type PushScheduleResult =
  | { ok: true; notifications: ScheduledPushNotification[] }
  | { ok: false; error: PushScheduleError };

// ISO 8601 with an explicit offset ("Z" or "±HH:MM"), as PostgREST returns
// timestamptz, with 1 to 6 fractional digits (Postgres precision). Anything
// else, including a time with no offset, is rejected.
const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:(Z)|([+-])(\d{2}):(\d{2}))$/;

// Microseconds since the epoch, exact, or null for anything that is not a
// real instant within the safe integer range (about 1684-07-28 to
// 2255-06-05). Unlike new Date(...), never rolls over (02-30, 24:00), assumes
// a time zone, or drops digits below the millisecond.
export function parseInstantMicros(value: string): number | null {
  const match = INSTANT_PATTERN.exec(value);
  if (match === null) return null;
  const [, y, mo, d, h, mi, s = "0", frac = "", z, sign, oh, om] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59 || second > 59) return null;
  // Day 0 of the next month is the last day of this one.
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null;
  let offsetMinutes = 0;
  if (z === undefined) {
    if (Number(oh) > 23 || Number(om) > 59) return null;
    offsetMinutes = (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
  }
  // Whole seconds through Date (integer milliseconds), then the fraction as
  // an integer number of microseconds: no rounding at any step.
  // setUTCFullYear keeps years 0-99 literal (Date.UTC would map them to 19xx).
  const utc = new Date(Date.UTC(2000, month - 1, day, hour, minute, second));
  utc.setUTCFullYear(year);
  const wholeSecondsUs = (utc.getTime() - offsetMinutes * 60 * 1000) * MS_US;
  if (!Number.isSafeInteger(wholeSecondsUs)) return null;
  const us = wholeSecondsUs + Number(frac.padEnd(6, "0"));
  return Number.isSafeInteger(us) ? us : null;
}

// "2026-11-10T12:00:00.123001Z": always UTC with 6 fractional digits, so
// parseInstantMicros gives the same value back. A value that is not a safe
// integer throws.
export function formatInstantMicros(us: number): string {
  if (!Number.isSafeInteger(us)) throw new RangeError("not a safe integer number of microseconds");
  // A non-negative remainder, also before the epoch (-1 µs is .999999 of the
  // previous second); us - rem is an exact multiple of 1000.
  const rem = ((us % MS_US) + MS_US) % MS_US;
  const iso = new Date((us - rem) / MS_US).toISOString();
  return `${iso.slice(0, -1)}${String(rem).padStart(3, "0")}Z`;
}

function dueTimes(publishedUs: number, startUs: number, endUs: number): Record<PushNotificationKind, number> {
  return {
    "new-sale": publishedUs,
    "three-days-before-start": startUs - 3 * DAY_US,
    "one-day-before-start": startUs - DAY_US,
    "at-start": startUs,
    "one-day-before-end": endUs - DAY_US,
    "three-hours-before-end": endUs - 3 * HOUR_US,
    "one-hour-before-end": endUs - HOUR_US,
  };
}

const END_KINDS: ReadonlySet<PushNotificationKind> = new Set([
  "one-day-before-end",
  "three-hours-before-end",
  "one-hour-before-end",
]);

// Kinds never sent from the end of the sale on: their deadline is the earlier
// of the grace period and the exclusive endsAt.
const CUT_OFF_AT_END_KINDS: ReadonlySet<PushNotificationKind> = new Set(["new-sale", "at-start"]);

// The sale's notifications in PUSH_NOTIFICATION_KINDS order. Left out:
// - a kind due before the sale was first published (never sent
//   retroactively);
// - an end notice due before the start (a short sale; due exactly at the
//   start is kept);
// - new-sale when the sale had already ended when first published
//   (publishedAt >= the exclusive endsAt).
// The deadlines of new-sale (24 hours after the first publish) and at-start
// (15 minutes after the start) are cut off at the end of the sale, so from
// endsAt on they have expired.
// Invalid input, or a time outside the safe range, is an error, never a guess.
export function schedulePushNotifications(sale: PushScheduleSale): PushScheduleResult {
  if (typeof sale.id !== "string" || sale.id === "") return { ok: false, error: "invalid-sale-id" };
  const startUs = parseInstantMicros(sale.startsAt);
  if (startUs === null) return { ok: false, error: "invalid-starts-at" };
  const endUs = parseInstantMicros(sale.endsAt);
  if (endUs === null) return { ok: false, error: "invalid-ends-at" };
  const publishedUs = parseInstantMicros(sale.publishedAt);
  if (publishedUs === null) return { ok: false, error: "invalid-published-at" };
  if (endUs <= startUs) return { ok: false, error: "ends-not-after-starts" };

  const due = dueTimes(publishedUs, startUs, endUs);
  const notifications: ScheduledPushNotification[] = [];
  for (const kind of PUSH_NOTIFICATION_KINDS) {
    const dueAtUs = due[kind];
    const graceEndUs = dueAtUs + PUSH_NOTIFICATION_GRACE_US[kind];
    if (!Number.isSafeInteger(dueAtUs) || !Number.isSafeInteger(graceEndUs)) {
      return { ok: false, error: "instant-out-of-range" };
    }
    if (dueAtUs < publishedUs) continue;
    if (END_KINDS.has(kind) && dueAtUs < startUs) continue;
    if (kind === "new-sale" && publishedUs >= endUs) continue;
    notifications.push({
      saleId: sale.id,
      kind,
      dueAtUs,
      deadlineAtUs: CUT_OFF_AT_END_KINDS.has(kind) ? Math.min(graceEndUs, endUs) : graceEndUs,
    });
  }
  return { ok: true, notifications };
}

export type PushNotificationTiming = "before-due" | "sendable" | "expired";

function checkedMicros(value: number, name: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${name} is not a safe integer number of microseconds`);
  return value;
}

// before-due: nowUs < dueAtUs. sendable: dueAtUs <= nowUs < deadlineAtUs.
// expired: nowUs >= deadlineAtUs. A value that is not a safe integer throws.
export function getPushNotificationTiming(
  notification: Pick<ScheduledPushNotification, "dueAtUs" | "deadlineAtUs">,
  nowUs: number,
): PushNotificationTiming {
  checkedMicros(nowUs, "nowUs");
  if (nowUs < checkedMicros(notification.dueAtUs, "dueAtUs")) return "before-due";
  if (nowUs < checkedMicros(notification.deadlineAtUs, "deadlineAtUs")) return "sendable";
  return "expired";
}

export type PushNotificationGroup = {
  saleId: string;
  dueAtUs: number;
  // The earliest deadline of the kinds included.
  deadlineAtUs: number;
  // In PUSH_NOTIFICATION_KINDS order.
  kinds: PushNotificationKind[];
};

export type PushNotificationRef = { saleId: string; kind: PushNotificationKind };

// The notifications to send at nowUs, one group per sale and exact due
// instant: kinds of the same sale due at the very same microsecond go out
// together; kinds due at different instants never do, even when both are
// sendable now.
// Left out first: kinds not sendable at nowUs, and the excluded ones (already
// settled elsewhere). A group with no kind left is not returned. The result
// does not depend on input order (groups by dueAtUs, then saleId). The same
// sale and kind given twice throws.
export function groupSendablePushNotifications(
  notifications: readonly ScheduledPushNotification[],
  nowUs: number,
  excluded: readonly PushNotificationRef[] = [],
): PushNotificationGroup[] {
  checkedMicros(nowUs, "nowUs");
  const seen = new Set<string>();
  const skip = new Set(excluded.map((ref) => JSON.stringify([ref.saleId, ref.kind])));
  const groups = new Map<string, PushNotificationGroup>();

  for (const notification of notifications) {
    const key = JSON.stringify([notification.saleId, notification.kind]);
    if (seen.has(key)) throw new RangeError("the same sale and kind was given more than once");
    seen.add(key);
    if (getPushNotificationTiming(notification, nowUs) !== "sendable" || skip.has(key)) continue;

    const { saleId, dueAtUs, deadlineAtUs } = notification;
    const groupKey = JSON.stringify([saleId, dueAtUs]);
    const group = groups.get(groupKey);
    if (group === undefined) {
      groups.set(groupKey, { saleId, dueAtUs, deadlineAtUs, kinds: [notification.kind] });
    } else {
      group.deadlineAtUs = Math.min(group.deadlineAtUs, deadlineAtUs);
      group.kinds.push(notification.kind);
    }
  }

  return [...groups.values()]
    .sort((a, b) => a.dueAtUs - b.dueAtUs || (a.saleId < b.saleId ? -1 : a.saleId > b.saleId ? 1 : 0))
    .map((group) => ({
      ...group,
      kinds: PUSH_NOTIFICATION_KINDS.filter((kind) => group.kinds.includes(kind)),
    }));
}

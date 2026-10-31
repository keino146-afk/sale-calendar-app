import { describe, expect, it } from "vitest";
import {
  formatInstantMicros,
  getPushNotificationTiming,
  groupSendablePushNotifications,
  parseInstantMicros,
  PUSH_NOTIFICATION_GRACE_US,
  PUSH_NOTIFICATION_KINDS,
  schedulePushNotifications,
  type PushNotificationRef,
  type PushScheduleSale,
  type ScheduledPushNotification,
} from "./push-notification-schedule";

const MINUTE_US = 60 * 1000 * 1000;
const HOUR_US = 60 * MINUTE_US;

// 11/10 00:00 JST to the exclusive end 11/12 00:00 JST, first published
// 11/1 10:00 JST.
const SALE: PushScheduleSale = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  startsAt: "2026-11-10T00:00:00+09:00",
  endsAt: "2026-11-12T00:00:00+09:00",
  publishedAt: "2026-11-01T10:00:00+09:00",
};
const OTHER_SALE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function schedule(sale: PushScheduleSale): ScheduledPushNotification[] {
  const result = schedulePushNotifications(sale);
  if (!result.ok) throw new Error(`unexpected error: ${result.error}`);
  return result.notifications;
}

function iso(notifications: ScheduledPushNotification[]) {
  return notifications.map(({ kind, dueAtUs, deadlineAtUs }) => [
    kind,
    formatInstantMicros(dueAtUs),
    formatInstantMicros(deadlineAtUs),
  ]);
}

// An instant (for nowUs and expected values) from an ISO string.
function us(value: string): number {
  const parsed = parseInstantMicros(value);
  if (parsed === null) throw new Error(`not an instant: ${value}`);
  return parsed;
}

function find(notifications: ScheduledPushNotification[], kind: string): ScheduledPushNotification {
  const notification = notifications.find((n) => n.kind === kind);
  if (notification === undefined) throw new Error(`no ${kind}`);
  return notification;
}

function groups(notifications: ScheduledPushNotification[], now: string, excluded: PushNotificationRef[] = []) {
  return groupSendablePushNotifications(notifications, us(now), excluded).map((g) => ({
    saleId: g.saleId,
    dueAt: formatInstantMicros(g.dueAtUs),
    deadlineAt: formatInstantMicros(g.deadlineAtUs),
    kinds: g.kinds,
  }));
}

describe("schedulePushNotifications", () => {
  it("defines exactly the 5 approved kinds, in order", () => {
    expect(PUSH_NOTIFICATION_KINDS).toEqual([
      "new-sale",
      "one-day-before-start",
      "at-start",
      "one-day-before-end",
      "two-hours-before-end",
    ]);
  });

  it("computes all 5 due times from the first publish, the start and the exclusive end", () => {
    expect(iso(schedule(SALE))).toEqual([
      ["new-sale", "2026-11-01T01:00:00.000000Z", "2026-11-02T01:00:00.000000Z"],
      ["one-day-before-start", "2026-11-08T15:00:00.000000Z", "2026-11-08T16:00:00.000000Z"],
      ["at-start", "2026-11-09T15:00:00.000000Z", "2026-11-09T15:15:00.000000Z"],
      ["one-day-before-end", "2026-11-10T15:00:00.000000Z", "2026-11-10T16:00:00.000000Z"],
      ["two-hours-before-end", "2026-11-11T13:00:00.000000Z", "2026-11-11T13:15:00.000000Z"],
    ]);
  });

  it("uses the approved grace periods: 24h, 1h, 15m, 1h, 15m", () => {
    expect(PUSH_NOTIFICATION_KINDS.map((kind) => PUSH_NOTIFICATION_GRACE_US[kind])).toEqual([
      24 * HOUR_US,
      HOUR_US,
      15 * MINUTE_US,
      HOUR_US,
      15 * MINUTE_US,
    ]);
    // SALE ends more than 24 hours after its publish, so no deadline is cut off.
    for (const notification of schedule(SALE)) {
      expect(notification.deadlineAtUs - notification.dueAtUs).toBe(PUSH_NOTIFICATION_GRACE_US[notification.kind]);
    }
  });

  it("treats the same instant written in different offsets as the same time", () => {
    const utc = schedule({
      ...SALE,
      startsAt: "2026-11-09T15:00:00Z",
      endsAt: "2026-11-11T15:00:00.000000+00:00",
      publishedAt: "2026-10-31T20:00:00-05:00",
    });
    expect(iso(utc)).toEqual(iso(schedule(SALE)));
  });

  it("leaves out kinds due before the first publish, never sending them retroactively", () => {
    // Published 11/9 12:00 JST: 1 day before the start (11/9 00:00 JST) has passed.
    const late = schedule({ ...SALE, publishedAt: "2026-11-09T12:00:00+09:00" });
    expect(late.map((n) => n.kind)).toEqual(["new-sale", "at-start", "one-day-before-end", "two-hours-before-end"]);

    // Published after the start: only the new-sale and end notifications.
    const afterStart = schedule({ ...SALE, publishedAt: "2026-11-10T09:00:00+09:00" });
    expect(afterStart.map((n) => n.kind)).toEqual(["new-sale", "one-day-before-end", "two-hours-before-end"]);
  });

  it("keeps a kind due at the very instant of the first publish", () => {
    const kinds = schedule({ ...SALE, publishedAt: "2026-11-09T00:00:00+09:00" }).map((n) => n.kind);
    expect(kinds).toEqual([...PUSH_NOTIFICATION_KINDS]);
  });

  it("compares a due time with the first publish to the microsecond", () => {
    // 1 day before the start is 11/8 15:00:00.000000Z.
    const oneMicroAfter = schedule({ ...SALE, publishedAt: "2026-11-08T15:00:00.000001Z" }).map((n) => n.kind);
    expect(oneMicroAfter).not.toContain("one-day-before-start");
    const exactly = schedule({ ...SALE, publishedAt: "2026-11-08T15:00:00.000000Z" }).map((n) => n.kind);
    expect(exactly).toContain("one-day-before-start");
  });

  describe("end notices of a short sale", () => {
    // 11/10 12:00 to the exclusive end 18:00 JST.
    const SIX_HOURS: PushScheduleSale = {
      ...SALE,
      startsAt: "2026-11-10T12:00:00+09:00",
      endsAt: "2026-11-10T18:00:00+09:00",
    };

    it("leaves out 1 day before the end when it falls before the start, keeps the later ones", () => {
      expect(iso(schedule(SIX_HOURS)).slice(2)).toEqual([
        ["at-start", "2026-11-10T03:00:00.000000Z", "2026-11-10T03:15:00.000000Z"],
        ["two-hours-before-end", "2026-11-10T07:00:00.000000Z", "2026-11-10T07:15:00.000000Z"],
      ]);
    });

    it("leaves out 2 hours before the end when it falls before the start, keeping every other kind", () => {
      // A 90-minute sale: 2 hours before the end is 30 minutes before the start.
      const kinds = schedule({ ...SIX_HOURS, endsAt: "2026-11-10T13:30:00+09:00" }).map((n) => n.kind);
      expect(kinds).toEqual(["new-sale", "one-day-before-start", "at-start"]);
    });

    it("leaves out an end notice 1 µs before the start", () => {
      // 2 hours before 13:59:59.999999 is 1 µs before the 12:00 start.
      const kinds = schedule({ ...SIX_HOURS, endsAt: "2026-11-10T13:59:59.999999+09:00" }).map((n) => n.kind);
      expect(kinds).not.toContain("two-hours-before-end");
    });

    it("keeps an end notice due exactly at the start, grouped with at-start under the earliest deadline", () => {
      // A 2-hour sale: 2 hours before the end is the start.
      const start = "2026-11-10T03:00:00.000000Z";
      const twoHours = schedule({ ...SIX_HOURS, endsAt: "2026-11-10T14:00:00+09:00" });
      expect(twoHours.map((n) => n.kind)).toEqual(["new-sale", "one-day-before-start", "at-start", "two-hours-before-end"]);
      expect(groups(twoHours, start)).toEqual([
        {
          saleId: SALE.id,
          dueAt: start,
          deadlineAt: "2026-11-10T03:15:00.000000Z",
          kinds: ["at-start", "two-hours-before-end"],
        },
      ]);
      // Both have 15 minutes: from then on neither is sendable.
      expect(groups(twoHours, "2026-11-10T03:15:00Z")).toEqual([]);
    });

    it("keeps the 15-minute grace and deadline boundaries of 2 hours before the end", () => {
      const twoHours = find(schedule(SIX_HOURS), "two-hours-before-end");
      expect(getPushNotificationTiming(twoHours, us("2026-11-10T06:59:59.999999Z"))).toBe("before-due");
      expect(getPushNotificationTiming(twoHours, us("2026-11-10T07:00:00Z"))).toBe("sendable");
      expect(getPushNotificationTiming(twoHours, us("2026-11-10T07:14:59.999999Z"))).toBe("sendable");
      expect(getPushNotificationTiming(twoHours, us("2026-11-10T07:15:00Z"))).toBe("expired");
      expect(getPushNotificationTiming(twoHours, us("2026-11-10T07:15:00.000001Z"))).toBe("expired");
    });

    it("counts 2 hours before the end from the stored exclusive end, to the microsecond and across a year", () => {
      // Official "until 11/15 1:59" is stored as 11/15 02:00 (PR #59): due 11/15 00:00 JST.
      const pr59 = find(schedule({ ...SALE, endsAt: "2026-11-15T02:00:00+09:00" }), "two-hours-before-end");
      expect(formatInstantMicros(pr59.dueAtUs)).toBe("2026-11-14T15:00:00.000000Z");
      // An end with a fraction keeps it.
      const fraction = find(schedule({ ...SALE, endsAt: "2026-11-15T02:00:00.000001+09:00" }), "two-hours-before-end");
      expect(formatInstantMicros(fraction.dueAtUs)).toBe("2026-11-14T15:00:00.000001Z");
      // An end at 1/1 01:00 JST: due 12/31 23:00 JST of the previous year.
      const newYear = find(schedule({ ...SALE, endsAt: "2027-01-01T01:00:00+09:00" }), "two-hours-before-end");
      expect(formatInstantMicros(newYear.dueAtUs)).toBe("2026-12-31T14:00:00.000000Z");
      expect(formatInstantMicros(newYear.deadlineAtUs)).toBe("2026-12-31T14:15:00.000000Z");
    });

    it("does not change its input", () => {
      const sale = Object.freeze({ ...SIX_HOURS });
      schedulePushNotifications(sale);
      expect(sale).toEqual(SIX_HOURS);
    });
  });

  describe("new-sale of a sale that had already ended when first published", () => {
    const PUBLISHED = "2026-10-31T12:00:00+09:00";

    it("is left out when published after the end, and no earlier notice comes back", () => {
      expect(
        schedule({
          ...SALE,
          startsAt: "2026-10-15T00:00:00+09:00",
          endsAt: "2026-10-20T23:59:00+09:00",
          publishedAt: PUBLISHED,
        }),
      ).toEqual([]);
    });

    it("is left out when published exactly at the exclusive end", () => {
      expect(
        schedule({ ...SALE, startsAt: "2026-10-25T00:00:00+09:00", endsAt: PUBLISHED, publishedAt: PUBLISHED }),
      ).toEqual([]);
    });

    it("is left out when published 1 µs after the end", () => {
      expect(
        schedule({
          ...SALE,
          startsAt: "2026-10-25T00:00:00+09:00",
          endsAt: "2026-10-31T11:59:59.999999+09:00",
          publishedAt: PUBLISHED,
        }),
      ).toEqual([]);
    });

    it("is kept when the sale is still running at the first publish", () => {
      const running = schedule({
        ...SALE,
        startsAt: "2026-10-25T00:00:00+09:00",
        endsAt: "2026-11-01T12:00:00+09:00",
        publishedAt: PUBLISHED,
      });
      expect(iso(running)).toEqual([
        ["new-sale", "2026-10-31T03:00:00.000000Z", "2026-11-01T03:00:00.000000Z"],
        ["one-day-before-end", "2026-10-31T03:00:00.000000Z", "2026-10-31T04:00:00.000000Z"],
        ["two-hours-before-end", "2026-11-01T01:00:00.000000Z", "2026-11-01T01:15:00.000000Z"],
      ]);
      // 1 day before the end falls at the publish instant: one group, earliest deadline.
      expect(groups(running, "2026-10-31T03:00:00Z")).toEqual([
        {
          saleId: SALE.id,
          dueAt: "2026-10-31T03:00:00.000000Z",
          deadlineAt: "2026-10-31T04:00:00.000000Z",
          kinds: ["new-sale", "one-day-before-end"],
        },
      ]);
    });

    it("is kept 1 µs before the end", () => {
      const kinds = schedule({
        ...SALE,
        startsAt: "2026-10-25T00:00:00+09:00",
        endsAt: "2026-10-31T12:00:00.000001+09:00",
        publishedAt: PUBLISHED,
      }).map((n) => n.kind);
      expect(kinds).toEqual(["new-sale"]);
    });
  });

  describe("new-sale deadline: the earlier of 24 hours after the first publish and the end", () => {
    // Published 10/31 12:00 JST.
    const PUBLISHED = "2026-10-31T12:00:00+09:00";

    it("is cut off at the end when the sale ends within 24 hours of the publish", () => {
      const [newSale] = schedule({
        ...SALE,
        startsAt: "2026-10-30T00:00:00+09:00",
        endsAt: "2026-10-31T18:00:00+09:00",
        publishedAt: PUBLISHED,
      });
      expect(newSale.kind).toBe("new-sale");
      expect(formatInstantMicros(newSale.dueAtUs)).toBe("2026-10-31T03:00:00.000000Z");
      expect(formatInstantMicros(newSale.deadlineAtUs)).toBe("2026-10-31T09:00:00.000000Z");
    });

    it("stays 24 hours after the publish when that comes first", () => {
      const newSale = find(schedule(SALE), "new-sale");
      expect(newSale.deadlineAtUs - newSale.dueAtUs).toBe(24 * HOUR_US);
    });

    it("is sendable up to 1 µs before the end and expired exactly at the end and after", () => {
      const newSale = find(
        schedule({
          ...SALE,
          startsAt: "2026-10-30T00:00:00+09:00",
          endsAt: "2026-10-31T18:00:00+09:00",
          publishedAt: PUBLISHED,
        }),
        "new-sale",
      );
      expect(getPushNotificationTiming(newSale, us("2026-10-31T08:59:59.999999Z"))).toBe("sendable");
      expect(getPushNotificationTiming(newSale, us("2026-10-31T09:00:00.000000Z"))).toBe("expired");
      expect(getPushNotificationTiming(newSale, us("2026-10-31T09:00:00.000001Z"))).toBe("expired");
    });

    it("changes no other kind's deadline", () => {
      const short = schedule({
        ...SALE,
        startsAt: "2026-10-31T12:00:00+09:00",
        endsAt: "2026-10-31T18:00:00+09:00",
        publishedAt: "2026-10-30T12:00:00+09:00",
      });
      for (const notification of short.filter((n) => n.kind !== "new-sale")) {
        expect(notification.deadlineAtUs - notification.dueAtUs).toBe(PUSH_NOTIFICATION_GRACE_US[notification.kind]);
      }
    });

    // A 5-minute sale published at its start: new-sale and at-start are due at
    // the same instant, and both are cut off at the end (5 min).
    describe("grouped with at-start", () => {
      const FIVE_MINUTES = schedule({
        ...SALE,
        startsAt: "2026-11-10T12:00:00+09:00",
        endsAt: "2026-11-10T12:05:00+09:00",
        publishedAt: "2026-11-10T12:00:00+09:00",
      });
      const START = "2026-11-10T03:00:00.000000Z";
      const END = "2026-11-10T03:05:00.000000Z";

      it("schedules only the two kinds due at the start, both until the end", () => {
        expect(iso(FIVE_MINUTES)).toEqual([
          ["new-sale", START, END],
          ["at-start", START, END],
        ]);
      });

      it("sends both together before the end, with the end as the deadline", () => {
        expect(groups(FIVE_MINUTES, "2026-11-10T03:04:59.999999Z")).toEqual([
          { saleId: SALE.id, dueAt: START, deadlineAt: END, kinds: ["new-sale", "at-start"] },
        ]);
      });

      it("returns no group from the end on: both kinds have expired", () => {
        for (const kind of ["new-sale", "at-start"]) {
          expect(getPushNotificationTiming(find(FIVE_MINUTES, kind), us(END))).toBe("expired");
        }
        expect(groups(FIVE_MINUTES, END)).toEqual([]);
        expect(groups(FIVE_MINUTES, "2026-11-10T03:05:00.000001Z")).toEqual([]);
      });
    });
  });

  describe("at-start deadline: the earlier of 15 minutes after the start and the end", () => {
    // Start 11/10 12:00 JST (03:00Z), published 11/1.
    const START = "2026-11-10T03:00:00.000000Z";
    function atStartOf(endsAt: string): ScheduledPushNotification {
      return find(schedule({ ...SALE, startsAt: "2026-11-10T12:00:00+09:00", endsAt }), "at-start");
    }

    it("is cut off at the end of a 5-minute sale, to the microsecond", () => {
      const atStart = atStartOf("2026-11-10T12:05:00+09:00");
      expect(formatInstantMicros(atStart.dueAtUs)).toBe(START);
      expect(formatInstantMicros(atStart.deadlineAtUs)).toBe("2026-11-10T03:05:00.000000Z");
      expect(getPushNotificationTiming(atStart, us("2026-11-10T02:59:59.999999Z"))).toBe("before-due");
      expect(getPushNotificationTiming(atStart, us(START))).toBe("sendable");
      expect(getPushNotificationTiming(atStart, us("2026-11-10T03:04:59.999999Z"))).toBe("sendable");
      expect(getPushNotificationTiming(atStart, us("2026-11-10T03:05:00.000000Z"))).toBe("expired");
      expect(getPushNotificationTiming(atStart, us("2026-11-10T03:05:00.000001Z"))).toBe("expired");
    });

    it("is 15 minutes after the start when the sale ends exactly then, expired at that instant", () => {
      const atStart = atStartOf("2026-11-10T12:15:00+09:00");
      expect(formatInstantMicros(atStart.deadlineAtUs)).toBe("2026-11-10T03:15:00.000000Z");
      expect(getPushNotificationTiming(atStart, us("2026-11-10T03:14:59.999999Z"))).toBe("sendable");
      expect(getPushNotificationTiming(atStart, us("2026-11-10T03:15:00Z"))).toBe("expired");
    });

    it("keeps the full 15 minutes when the sale runs longer", () => {
      const atStart = atStartOf("2026-11-10T14:00:00+09:00");
      expect(formatInstantMicros(atStart.deadlineAtUs)).toBe("2026-11-10T03:15:00.000000Z");
      expect(atStart.deadlineAtUs - atStart.dueAtUs).toBe(15 * MINUTE_US);
    });

    it("leaves the kinds before the start untouched in a 5-minute sale", () => {
      const fiveMinutes = schedule({ ...SALE, startsAt: "2026-11-10T12:00:00+09:00", endsAt: "2026-11-10T12:05:00+09:00" });
      const dayBefore = find(fiveMinutes, "one-day-before-start");
      expect(dayBefore.deadlineAtUs - dayBefore.dueAtUs).toBe(HOUR_US);
      // Published 11/1, well before the end: new-sale keeps its 24 hours.
      const newSale = find(fiveMinutes, "new-sale");
      expect(newSale.deadlineAtUs - newSale.dueAtUs).toBe(24 * HOUR_US);
    });
  });

  // Responsibility boundary: a new input gives a new schedule, but this module
  // cannot invalidate a schedule computed earlier. Reading the latest sale
  // before sending is the job of the worker that calls it.
  it("recomputes new-sale's deadline from an edited end, without touching the earlier result", () => {
    const before = schedule({ ...SALE, startsAt: "2026-10-30T00:00:00+09:00", publishedAt: "2026-10-31T12:00:00+09:00" });
    const snapshot = iso(before);
    const after = schedule({
      ...SALE,
      startsAt: "2026-10-30T00:00:00+09:00",
      endsAt: "2026-10-31T18:00:00+09:00",
      publishedAt: "2026-10-31T12:00:00+09:00",
    });
    expect(formatInstantMicros(find(before, "new-sale").deadlineAtUs)).toBe("2026-11-01T03:00:00.000000Z");
    expect(formatInstantMicros(find(after, "new-sale").deadlineAtUs)).toBe("2026-10-31T09:00:00.000000Z");
    expect(iso(before)).toEqual(snapshot);
  });

  it("returns the notifications of the given sale only", () => {
    expect(schedule(SALE).every((n) => n.saleId === SALE.id)).toBe(true);
  });

  it.each([
    ["no offset", "2026-11-10T00:00:00"],
    ["a date only", "2026-11-10"],
    ["a day that does not exist", "2026-02-30T00:00:00Z"],
    ["hour 24", "2026-11-10T24:00:00Z"],
    ["month 13", "2026-13-01T00:00:00Z"],
    ["an offset without a colon", "2026-11-10T00:00:00+0900"],
    ["a space separator", "2026-11-10 00:00:00+09:00"],
    ["an empty string", ""],
    ["text", "tomorrow"],
  ])("rejects a start with %s", (_label, startsAt) => {
    expect(schedulePushNotifications({ ...SALE, startsAt })).toEqual({ ok: false, error: "invalid-starts-at" });
  });

  it("rejects an invalid end, publish time or sale id", () => {
    expect(schedulePushNotifications({ ...SALE, endsAt: "2026-11-12T00:00:00" })).toEqual({
      ok: false,
      error: "invalid-ends-at",
    });
    expect(schedulePushNotifications({ ...SALE, publishedAt: "not a time" })).toEqual({
      ok: false,
      error: "invalid-published-at",
    });
    expect(schedulePushNotifications({ ...SALE, id: "" })).toEqual({ ok: false, error: "invalid-sale-id" });
  });

  it("rejects an end that is not after the start", () => {
    expect(schedulePushNotifications({ ...SALE, endsAt: SALE.startsAt })).toEqual({
      ok: false,
      error: "ends-not-after-starts",
    });
    expect(schedulePushNotifications({ ...SALE, endsAt: "2026-11-09T00:00:00+09:00" })).toEqual({
      ok: false,
      error: "ends-not-after-starts",
    });
  });

  it("fails on a time that leaves the safe integer range instead of rounding it", () => {
    // Valid instants, but 24 hours after the publish is past the safe range.
    expect(
      schedulePushNotifications({
        ...SALE,
        startsAt: "2255-06-01T00:00:00Z",
        endsAt: "2255-06-05T00:00:00Z",
        publishedAt: "2255-06-05T00:00:00Z",
      }),
    ).toEqual({ ok: false, error: "instant-out-of-range" });
  });

  it("does not change its input", () => {
    const sale = Object.freeze({ ...SALE });
    schedulePushNotifications(sale);
    expect(sale).toEqual(SALE);
  });
});

describe("parseInstantMicros", () => {
  const BASE = Date.UTC(2026, 10, 10, 12) * 1000;

  it("reads 1 to 6 fractional digits exactly, padding on the right", () => {
    expect(parseInstantMicros("2026-11-10T12:00:00Z")).toBe(BASE);
    expect(parseInstantMicros("2026-11-10T12:00Z")).toBe(BASE);
    expect(parseInstantMicros("2026-11-10T12:00:00.1Z")).toBe(BASE + 100000);
    expect(parseInstantMicros("2026-11-10T12:00:00.12Z")).toBe(BASE + 120000);
    expect(parseInstantMicros("2026-11-10T12:00:00.123Z")).toBe(BASE + 123000);
    expect(parseInstantMicros("2026-11-10T12:00:00.1234Z")).toBe(BASE + 123400);
    expect(parseInstantMicros("2026-11-10T12:00:00.12345Z")).toBe(BASE + 123450);
    expect(parseInstantMicros("2026-11-10T12:00:00.123456Z")).toBe(BASE + 123456);
  });

  it("keeps two times in the same millisecond apart", () => {
    const a = parseInstantMicros("2026-11-10T12:00:00.123001Z");
    const b = parseInstantMicros("2026-11-10T12:00:00.123999Z");
    expect(a).toBe(BASE + 123001);
    expect(b).toBe(BASE + 123999);
    expect(b! - a!).toBe(998);
  });

  it("reads Z and ±HH:MM offsets as the same absolute instant", () => {
    expect(parseInstantMicros("2026-11-10T21:00:00.123001+09:00")).toBe(BASE + 123001);
    expect(parseInstantMicros("2026-11-10T07:30:00.123001-04:30")).toBe(BASE + 123001);
    expect(parseInstantMicros("2026-11-10T12:00:00.123001+00:00")).toBe(BASE + 123001);
  });

  it.each([
    ["7 fractional digits", "2026-11-10T12:00:00.1234567Z"],
    ["an empty fraction", "2026-11-10T12:00:00.Z"],
    ["an offset hour of 24", "2026-11-10T12:00:00+24:00"],
    ["an offset minute of 60", "2026-11-10T12:00:00+09:60"],
    ["a one-digit offset hour", "2026-11-10T12:00:00+9:00"],
    ["an offset without minutes", "2026-11-10T12:00:00+09"],
    ["no offset", "2026-11-10T12:00:00.123001"],
    ["a day that does not exist", "2026-02-29T00:00:00Z"],
    ["day 0", "2026-11-00T00:00:00Z"],
    ["second 60", "2026-11-10T12:00:60Z"],
    ["minute 60", "2026-11-10T12:60:00Z"],
  ])("rejects %s", (_label, value) => {
    expect(parseInstantMicros(value)).toBeNull();
  });

  it("accepts a leap day", () => {
    expect(parseInstantMicros("2028-02-29T00:00:00Z")).toBe(Date.UTC(2028, 1, 29) * 1000);
  });

  it("accepts exactly the safe integer range and nothing past it", () => {
    expect(parseInstantMicros("2255-06-05T23:47:34.740991Z")).toBe(Number.MAX_SAFE_INTEGER);
    expect(parseInstantMicros("2255-06-05T23:47:34.740992Z")).toBeNull();
    expect(parseInstantMicros("2300-01-01T00:00:00Z")).toBeNull();
    expect(parseInstantMicros("9999-12-31T23:59:59.999999Z")).toBeNull();
    // Before the epoch, the whole seconds must be in range on their own.
    expect(parseInstantMicros("1684-07-28T00:12:26.000000Z")).toBe(-9007199254000000);
    expect(parseInstantMicros("1684-07-28T00:12:25.999999Z")).toBeNull();
    expect(parseInstantMicros("1600-01-01T00:00:00Z")).toBeNull();
  });
});

describe("formatInstantMicros", () => {
  it("writes UTC with 6 fractional digits", () => {
    expect(formatInstantMicros(Date.UTC(2026, 10, 10, 12) * 1000 + 123001)).toBe("2026-11-10T12:00:00.123001Z");
    expect(formatInstantMicros(Date.UTC(2026, 10, 10, 12) * 1000)).toBe("2026-11-10T12:00:00.000000Z");
    expect(formatInstantMicros(0)).toBe("1970-01-01T00:00:00.000000Z");
  });

  it("carries across second and day boundaries", () => {
    const lastMicro = us("2026-11-10T23:59:59.999999Z");
    expect(formatInstantMicros(lastMicro)).toBe("2026-11-10T23:59:59.999999Z");
    expect(formatInstantMicros(lastMicro + 1)).toBe("2026-11-11T00:00:00.000000Z");
  });

  it("keeps the fraction positive before the epoch", () => {
    expect(formatInstantMicros(-1)).toBe("1969-12-31T23:59:59.999999Z");
    expect(formatInstantMicros(-1000)).toBe("1969-12-31T23:59:59.999000Z");
    expect(formatInstantMicros(-1001)).toBe("1969-12-31T23:59:59.998999Z");
    expect(formatInstantMicros(-1000000)).toBe("1969-12-31T23:59:59.000000Z");
  });

  it("round-trips with parseInstantMicros without losing a microsecond", () => {
    for (const value of [
      "2026-11-10T12:00:00.123001Z",
      "2026-11-10T12:00:00.123999Z",
      "2026-11-10T12:00:00.000001Z",
      "1969-12-31T23:59:59.999999Z",
      "2255-06-05T23:47:34.740991Z",
      "1684-07-28T00:12:26.000000Z",
    ]) {
      expect(formatInstantMicros(us(value))).toBe(value);
      expect(us(formatInstantMicros(us(value)))).toBe(us(value));
    }
    expect(formatInstantMicros(us("2026-11-10T21:00:00.5+09:00"))).toBe("2026-11-10T12:00:00.500000Z");
  });

  it.each([
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["past the safe range", Number.MAX_SAFE_INTEGER + 1],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("throws on %s", (_label, value) => {
    expect(() => formatInstantMicros(value)).toThrow(RangeError);
  });
});

describe("getPushNotificationTiming", () => {
  const atStart = find(schedule(SALE), "at-start");

  it("is before-due until the due time, then sendable until just before the deadline", () => {
    expect(getPushNotificationTiming(atStart, us("2026-11-09T14:59:59.999999Z"))).toBe("before-due");
    expect(getPushNotificationTiming(atStart, us("2026-11-09T15:00:00.000000Z"))).toBe("sendable");
    expect(getPushNotificationTiming(atStart, us("2026-11-09T15:07:00Z"))).toBe("sendable");
    expect(getPushNotificationTiming(atStart, us("2026-11-09T15:14:59.999999Z"))).toBe("sendable");
  });

  it("is expired exactly at the deadline and after it", () => {
    expect(getPushNotificationTiming(atStart, us("2026-11-09T15:15:00.000000Z"))).toBe("expired");
    expect(getPushNotificationTiming(atStart, us("2026-11-09T15:15:00.000001Z"))).toBe("expired");
  });

  it("is exact to the microsecond for a due time inside a millisecond", () => {
    const notification = find(schedule({ ...SALE, startsAt: "2026-11-09T15:00:00.000900Z" }), "at-start");
    expect(getPushNotificationTiming(notification, us("2026-11-09T15:00:00.000899Z"))).toBe("before-due");
    expect(getPushNotificationTiming(notification, us("2026-11-09T15:00:00.000900Z"))).toBe("sendable");
    expect(getPushNotificationTiming(notification, us("2026-11-09T15:15:00.000899Z"))).toBe("sendable");
    expect(getPushNotificationTiming(notification, us("2026-11-09T15:15:00.000900Z"))).toBe("expired");
  });

  it.each([
    ["NaN", Number.NaN],
    ["a fraction", 1.5],
    ["past the safe range", Number.MAX_SAFE_INTEGER + 1],
  ])("throws on a now that is %s instead of guessing one", (_label, nowUs) => {
    expect(() => getPushNotificationTiming(atStart, nowUs)).toThrow(RangeError);
  });

  it("throws on a due time or deadline that is not a safe integer", () => {
    expect(() => getPushNotificationTiming({ ...atStart, dueAtUs: 0.5 }, 0)).toThrow(RangeError);
    expect(() => getPushNotificationTiming({ ...atStart, deadlineAtUs: Number.NaN }, atStart.dueAtUs)).toThrow(RangeError);
  });
});

describe("groupSendablePushNotifications", () => {
  // A one-day date-only sale: 1 day before the exclusive end is the start.
  const ONE_DAY: PushScheduleSale = {
    ...SALE,
    startsAt: "2026-11-10T00:00:00+09:00",
    endsAt: "2026-11-11T00:00:00+09:00",
  };
  const START = "2026-11-09T15:00:00.000000Z";

  it("puts kinds of the same sale due at the same instant in one group, with the earliest deadline", () => {
    expect(groups(schedule(ONE_DAY), START)).toEqual([
      {
        saleId: SALE.id,
        dueAt: START,
        deadlineAt: "2026-11-09T15:15:00.000000Z",
        kinds: ["at-start", "one-day-before-end"],
      },
    ]);
  });

  it("matches due instants as times, not as text", () => {
    const atStart = find(schedule(SALE), "at-start");
    const endDay = find(schedule({ ...ONE_DAY, endsAt: "2026-11-10T15:00:00.000000+00:00" }), "one-day-before-end");
    expect(groups([atStart, endDay], START)[0].kinds).toEqual(["at-start", "one-day-before-end"]);
  });

  it("never groups due instants 1 µs apart", () => {
    // 1 day before the end is 1 µs after the start.
    const apart = schedule({ ...ONE_DAY, endsAt: "2026-11-10T15:00:00.000001Z" });
    expect(groups(apart, "2026-11-09T15:00:00.000001Z")).toEqual([
      { saleId: SALE.id, dueAt: START, deadlineAt: "2026-11-09T15:15:00.000000Z", kinds: ["at-start"] },
      {
        saleId: SALE.id,
        dueAt: "2026-11-09T15:00:00.000001Z",
        deadlineAt: "2026-11-09T16:00:00.000001Z",
        kinds: ["one-day-before-end"],
      },
    ]);
  });

  it("never groups two due instants in the same millisecond", () => {
    const sameMilli = schedule({
      ...ONE_DAY,
      startsAt: "2026-11-09T15:00:00.123001Z",
      endsAt: "2026-11-10T15:00:00.123999Z",
    });
    const result = groups(sameMilli, "2026-11-09T15:00:00.124Z");
    expect(result.map((g) => [g.dueAt, g.kinds])).toEqual([
      ["2026-11-09T15:00:00.123001Z", ["at-start"]],
      ["2026-11-09T15:00:00.123999Z", ["one-day-before-end"]],
    ]);
  });

  it("never groups kinds due at different instants, even when both are sendable now", () => {
    // Published 11/8 14:30Z: at 15:10Z both new-sale (due 14:30Z) and 1 day
    // before the start (due 15:00Z) are sendable, but stay separate.
    const sale = schedule({ ...SALE, publishedAt: "2026-11-08T14:30:00Z" });
    expect(groups(sale, "2026-11-08T15:10:00Z")).toEqual([
      {
        saleId: SALE.id,
        dueAt: "2026-11-08T14:30:00.000000Z",
        deadlineAt: "2026-11-09T14:30:00.000000Z",
        kinds: ["new-sale"],
      },
      {
        saleId: SALE.id,
        dueAt: "2026-11-08T15:00:00.000000Z",
        deadlineAt: "2026-11-08T16:00:00.000000Z",
        kinds: ["one-day-before-start"],
      },
    ]);
  });

  it("drops a kind that has expired and keeps the rest, with their own earliest deadline", () => {
    // 20 minutes after the start: at-start (15m) has expired, 1 day before the end (1h) has not.
    expect(groups(schedule(ONE_DAY), "2026-11-09T15:20:00Z")).toEqual([
      { saleId: SALE.id, dueAt: START, deadlineAt: "2026-11-09T16:00:00.000000Z", kinds: ["one-day-before-end"] },
    ]);
  });

  it("drops excluded kinds before grouping", () => {
    expect(groups(schedule(ONE_DAY), START, [{ saleId: SALE.id, kind: "at-start" }])).toEqual([
      { saleId: SALE.id, dueAt: START, deadlineAt: "2026-11-09T16:00:00.000000Z", kinds: ["one-day-before-end"] },
    ]);
    // An exclusion for another sale changes nothing here.
    expect(groups(schedule(ONE_DAY), START, [{ saleId: OTHER_SALE_ID, kind: "at-start" }])[0].kinds).toEqual([
      "at-start",
      "one-day-before-end",
    ]);
  });

  it("returns no group when no kind is left", () => {
    const all = schedule(ONE_DAY);
    expect(groups(all, "2026-11-09T16:00:00Z")).toEqual([]);
    expect(
      groups(all, START, [
        { saleId: SALE.id, kind: "at-start" },
        { saleId: SALE.id, kind: "one-day-before-end" },
      ]),
    ).toEqual([]);
    expect(groups(all, "2026-11-09T14:59:59.999999Z")).toEqual([]);
    expect(groups([], START)).toEqual([]);
  });

  it("never groups notifications of different sales, even at the same instant", () => {
    const other = schedule({ ...ONE_DAY, id: OTHER_SALE_ID });
    expect(groups([...schedule(ONE_DAY), ...other], START)).toEqual([
      {
        saleId: SALE.id,
        dueAt: START,
        deadlineAt: "2026-11-09T15:15:00.000000Z",
        kinds: ["at-start", "one-day-before-end"],
      },
      {
        saleId: OTHER_SALE_ID,
        dueAt: START,
        deadlineAt: "2026-11-09T15:15:00.000000Z",
        kinds: ["at-start", "one-day-before-end"],
      },
    ]);
  });

  it("gives the same result whatever the input order", () => {
    const all = [...schedule(ONE_DAY), ...schedule({ ...ONE_DAY, id: OTHER_SALE_ID })];
    const expected = groups(all, START);
    expect(groups([...all].reverse(), START)).toEqual(expected);
    expect(groups([all[3], all[0], all[2], all[1], ...all.slice(4)], START)).toEqual(expected);
  });

  it("does not change its input", () => {
    const all = schedule(ONE_DAY).map((n) => Object.freeze({ ...n }));
    const snapshot = iso(all);
    const excluded = Object.freeze([Object.freeze({ saleId: SALE.id, kind: "at-start" as const })]);
    groupSendablePushNotifications(Object.freeze(all), us(START), excluded);
    expect(iso(all)).toEqual(snapshot);
    expect(excluded).toEqual([{ saleId: SALE.id, kind: "at-start" }]);
  });

  it("throws on the same sale and kind given twice, or an invalid now", () => {
    const all = schedule(ONE_DAY);
    expect(() => groupSendablePushNotifications([...all, all[0]], us(START))).toThrow(RangeError);
    expect(() => groupSendablePushNotifications(all, Number.NaN)).toThrow(RangeError);
    expect(() => groupSendablePushNotifications(all, us(START) + 0.5)).toThrow(RangeError);
  });

  // Responsibility boundary: this module keeps no state. Asked again, it
  // offers the same due group again; never resending after accepted,
  // unknown, expired or cancelled (or after an edit of the sale) must be
  // enforced by the persistent delivery state that uses it.
  it("keeps no record of what was sent: the same call returns the same group again", () => {
    const all = schedule(ONE_DAY);
    expect(groups(all, START)).toEqual(groups(all, START));
    expect(groups(all, START)).toHaveLength(1);
  });
});

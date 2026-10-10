import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  DAY_MS,
  formatJstFullDate,
  formatJstMonthDayTime,
  formatJstMonthDayWeekday,
  getJstParts,
  jstDateKey,
  jstDayStart,
  startOfJstDay,
} from "./jst";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("JST helpers", () => {
  it("treats UTC 15:00 as the start of the next JST day", () => {
    const before = new Date("2026-10-31T14:59:59.999Z");
    const boundary = new Date("2026-10-31T15:00:00.000Z");

    expect(jstDateKey(before)).toBe("2026-10-31");
    expect(jstDateKey(boundary)).toBe("2026-11-01");
    expect(startOfJstDay(boundary).toISOString()).toBe("2026-10-31T15:00:00.000Z");
    expect(startOfJstDay(before).toISOString()).toBe("2026-10-30T15:00:00.000Z");
  });

  it("returns JST parts for a normal day", () => {
    expect(getJstParts(new Date("2026-10-10T03:04:00Z"))).toEqual({
      year: 2026,
      month: 10,
      day: 10,
      hour: 12,
      minute: 4,
      weekday: 6,
    });
  });

  it("computes month start and end boundaries", () => {
    expect(jstDayStart(2026, 10, 1).toISOString()).toBe("2026-09-30T15:00:00.000Z");
    // Day 0 of next month = last day of this month.
    expect(jstDateKey(jstDayStart(2026, 11, 0))).toBe("2026-10-31");
  });

  it("rolls over from December to January", () => {
    const lastDay = jstDayStart(2026, 12, 31);
    expect(jstDateKey(addDays(lastDay, 1))).toBe("2027-01-01");
    expect(jstDateKey(jstDayStart(2026, 13, 1))).toBe("2027-01-01");
  });

  it("handles leap-year February", () => {
    expect(jstDateKey(jstDayStart(2028, 3, 0))).toBe("2028-02-29");
    expect(jstDateKey(jstDayStart(2026, 3, 0))).toBe("2026-02-28");
  });

  it("adds whole days as fixed 24-hour steps", () => {
    const start = new Date("2026-10-10T00:00:00Z");
    expect(addDays(start, 14).getTime() - start.getTime()).toBe(14 * DAY_MS);
    expect(addDays(start, -1).toISOString()).toBe("2026-10-09T00:00:00.000Z");
  });

  it("formats dates for display", () => {
    const date = new Date("2026-10-31T15:30:00Z"); // 2026-11-01 00:30 JST (Sunday)
    expect(formatJstMonthDayWeekday(date)).toBe("11/1(日)");
    expect(formatJstMonthDayTime(date)).toBe("11/1 00:30");
    expect(formatJstFullDate(date)).toBe("2026/11/1");
  });

  it("does not depend on the process time zone", () => {
    const date = new Date("2026-10-31T15:30:00Z");
    for (const tz of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      vi.stubEnv("TZ", tz);
      expect(jstDateKey(date)).toBe("2026-11-01");
      expect(formatJstMonthDayTime(date)).toBe("11/1 00:30");
    }
  });
});

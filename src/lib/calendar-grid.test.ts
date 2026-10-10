import { describe, expect, it } from "vitest";
import {
  assignEventsToDays,
  buildCalendarDays,
  CALENDAR_DAYS,
  calendarHref,
  calendarRange,
  filterMonthSales,
  gridStart,
  monthStart,
  nextMonthStart,
  resolveYearMonth,
  shiftMonth,
  splitVisibleEvents,
} from "./calendar-grid";

const NOW = new Date("2026-10-10T03:00:00.000Z"); // 2026-10-10 12:00 JST (Saturday)
const OCT_2026 = { year: 2026, month: 10 };

function sale(id: string, startsAt: string, endsAt: string, isDateOnly = false) {
  return { id, startsAt, endsAt, isDateOnly };
}

describe("resolveYearMonth", () => {
  it("accepts a valid year and month", () => {
    expect(resolveYearMonth("2027", "3", NOW)).toEqual({ year: 2027, month: 3 });
    expect(resolveYearMonth("2020", "1", NOW)).toEqual({ year: 2020, month: 1 });
    expect(resolveYearMonth("2100", "12", NOW)).toEqual({ year: 2100, month: 12 });
  });

  it("uses the current JST month when nothing is given", () => {
    expect(resolveYearMonth(undefined, undefined, NOW)).toEqual(OCT_2026);
    // 2026-10-31 15:00 UTC is already 2026-11-01 in JST.
    expect(resolveYearMonth(undefined, undefined, new Date("2026-10-31T15:00:00Z"))).toEqual({
      year: 2026,
      month: 11,
    });
  });

  it.each([
    ["too early", "2019", "12"],
    ["too late", "2101", "1"],
    ["not a number", "abcd", "10"],
    ["negative", "-2026", "10"],
    ["decimal", "2026.5", "10"],
    ["repeated", ["2026", "2027"], "10"],
    ["missing", undefined, "10"],
  ])("falls back for an invalid year (%s)", (_label, year, month) => {
    expect(resolveYearMonth(year, month, NOW)).toEqual(OCT_2026);
  });

  it.each([
    ["zero", "0"],
    ["thirteen", "13"],
    ["not a number", "oct"],
    ["repeated", ["1", "2"]],
    ["missing", undefined],
  ])("falls back for an invalid month (%s)", (_label, month) => {
    expect(resolveYearMonth("2027", month, NOW)).toEqual(OCT_2026);
  });
});

describe("shiftMonth", () => {
  it("rolls January back to December of the previous year", () => {
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
  });

  it("rolls December forward to January of the next year", () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
  });

  it("moves within a year", () => {
    expect(shiftMonth(OCT_2026, -1)).toEqual({ year: 2026, month: 9 });
    expect(shiftMonth(OCT_2026, 1)).toEqual({ year: 2026, month: 11 });
  });

  it("returns null outside the supported range", () => {
    expect(shiftMonth({ year: 2020, month: 1 }, -1)).toBeNull();
    expect(shiftMonth({ year: 2100, month: 12 }, 1)).toBeNull();
  });
});

describe("month boundaries", () => {
  it("uses JST midnight for month starts", () => {
    expect(monthStart(OCT_2026).toISOString()).toBe("2026-09-30T15:00:00.000Z");
    expect(nextMonthStart(OCT_2026).toISOString()).toBe("2026-10-31T15:00:00.000Z");
    expect(nextMonthStart({ year: 2026, month: 12 }).toISOString()).toBe(
      "2026-12-31T15:00:00.000Z",
    );
  });
});

describe("buildCalendarDays", () => {
  it("always has 42 days", () => {
    for (const yearMonth of [OCT_2026, { year: 2026, month: 2 }, { year: 2028, month: 2 }]) {
      expect(buildCalendarDays(yearMonth, NOW)).toHaveLength(CALENDAR_DAYS);
    }
    expect(CALENDAR_DAYS).toBe(42);
  });

  it("starts on Sunday and ends on Saturday", () => {
    const days = buildCalendarDays(OCT_2026, NOW);
    expect(days[0].weekday).toBe(0);
    expect(days[41].weekday).toBe(6);
    expect(days.map((day) => day.weekday).slice(0, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("covers 2026-09-27 to 2026-11-07 for October 2026", () => {
    const days = buildCalendarDays(OCT_2026, NOW);
    expect(days[0].key).toBe("2026-09-27");
    expect(days[41].key).toBe("2026-11-07");
    expect(gridStart(OCT_2026).toISOString()).toBe("2026-09-26T15:00:00.000Z");
    expect(calendarRange(OCT_2026)).toEqual({
      from: new Date("2026-09-26T15:00:00.000Z"),
      to: new Date("2026-11-07T15:00:00.000Z"),
    });
  });

  it("starts on the 1st when the month begins on Sunday", () => {
    const days = buildCalendarDays({ year: 2026, month: 2 }, NOW);
    expect(days[0].key).toBe("2026-02-01");
    expect(days[0].inMonth).toBe(true);
  });

  it("handles January (grid starts in the previous year) and December", () => {
    expect(buildCalendarDays({ year: 2026, month: 1 }, NOW)[0].key).toBe("2025-12-28");
    expect(buildCalendarDays({ year: 2026, month: 12 }, NOW)[41].key).toBe("2027-01-09");
  });

  it("handles leap-year February", () => {
    const leap = buildCalendarDays({ year: 2028, month: 2 }, NOW);
    expect(leap[0].key).toBe("2028-01-30");
    expect(leap.filter((day) => day.inMonth)).toHaveLength(29);
    expect(leap.find((day) => day.key === "2028-02-29")?.inMonth).toBe(true);
    expect(leap.find((day) => day.key === "2028-03-01")?.inMonth).toBe(false);

    const common = buildCalendarDays({ year: 2026, month: 2 }, NOW);
    expect(common.filter((day) => day.inMonth)).toHaveLength(28);
  });

  it("marks current-month and outside-month days", () => {
    const days = buildCalendarDays(OCT_2026, NOW);
    expect(days.filter((day) => day.inMonth)).toHaveLength(31);
    expect(days.find((day) => day.key === "2026-09-30")?.inMonth).toBe(false);
    expect(days.find((day) => day.key === "2026-10-01")?.inMonth).toBe(true);
    expect(days.find((day) => day.key === "2026-10-31")?.inMonth).toBe(true);
    expect(days.find((day) => day.key === "2026-11-01")?.inMonth).toBe(false);
  });

  it("marks today in JST only", () => {
    const days = buildCalendarDays(OCT_2026, NOW);
    expect(days.filter((day) => day.isToday).map((day) => day.key)).toEqual(["2026-10-10"]);

    // 2026-10-10 15:00 UTC is 2026-10-11 00:00 JST.
    const late = buildCalendarDays(OCT_2026, new Date("2026-10-10T15:00:00Z"));
    expect(late.filter((day) => day.isToday).map((day) => day.key)).toEqual(["2026-10-11"]);

    expect(buildCalendarDays({ year: 2026, month: 12 }, NOW).some((day) => day.isToday)).toBe(
      false,
    );
  });

  it("uses JST midnight half-open day bounds", () => {
    const day = buildCalendarDays(OCT_2026, NOW).find((d) => d.key === "2026-10-10");
    expect(day?.start.toISOString()).toBe("2026-10-09T15:00:00.000Z");
    expect(day?.end.toISOString()).toBe("2026-10-10T15:00:00.000Z");
  });
});

describe("assignEventsToDays", () => {
  const days = buildCalendarDays(OCT_2026, NOW);

  function keysFor(id: string, cells: { key: string; events: { id: string }[] }[]) {
    return cells.filter((cell) => cell.events.some((e) => e.id === id)).map((cell) => cell.key);
  }

  it("assigns a single-day sale to one day", () => {
    // 2026-10-15 20:00 JST to 23:00 JST.
    const cells = assignEventsToDays(days, [
      sale("s", "2026-10-15T11:00:00Z", "2026-10-15T14:00:00Z"),
    ]);
    expect(keysFor("s", cells)).toEqual(["2026-10-15"]);
  });

  it("assigns a multi-day sale to every overlapped day", () => {
    // 2026-10-04 20:00 JST to 2026-10-07 02:00 JST.
    const cells = assignEventsToDays(days, [
      sale("m", "2026-10-04T11:00:00Z", "2026-10-06T17:00:00Z"),
    ]);
    expect(keysFor("m", cells)).toEqual(["2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"]);
  });

  it("treats endsAt as exclusive for date-only sales", () => {
    // Date-only 2026-11-01 to 2026-11-03 (exclusive end 2026-11-04 00:00 JST).
    const cells = assignEventsToDays(days, [
      sale("d", "2026-10-31T15:00:00Z", "2026-11-03T15:00:00Z", true),
    ]);
    expect(keysFor("d", cells)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03"]);
  });

  it("does not include a sale ending exactly at the day start", () => {
    // Ends at 2026-10-10 00:00 JST.
    const cells = assignEventsToDays(days, [
      sale("e", "2026-10-09T03:00:00Z", "2026-10-09T15:00:00Z"),
    ]);
    expect(keysFor("e", cells)).toEqual(["2026-10-09"]);
  });

  it("does not include a sale starting exactly at the day end", () => {
    // Starts at 2026-10-11 00:00 JST.
    const cells = assignEventsToDays(days, [
      sale("b", "2026-10-10T15:00:00Z", "2026-10-11T03:00:00Z"),
    ]);
    expect(keysFor("b", cells)).toEqual(["2026-10-11"]);
  });

  it("counts events per day", () => {
    const cells = assignEventsToDays(days, [
      sale("1", "2026-10-15T00:00:00Z", "2026-10-15T01:00:00Z"),
      sale("2", "2026-10-15T02:00:00Z", "2026-10-15T03:00:00Z"),
      sale("3", "2026-10-15T04:00:00Z", "2026-10-15T05:00:00Z"),
    ]);
    expect(cells.find((cell) => cell.key === "2026-10-15")?.events).toHaveLength(3);
    expect(cells.find((cell) => cell.key === "2026-10-16")?.events).toHaveLength(0);
  });
});

describe("splitVisibleEvents", () => {
  it("shows at most two events and counts the rest", () => {
    expect(splitVisibleEvents(["a", "b", "c", "d"])).toEqual({
      visible: ["a", "b"],
      hiddenCount: 2,
    });
    expect(splitVisibleEvents(["a", "b"])).toEqual({ visible: ["a", "b"], hiddenCount: 0 });
    expect(splitVisibleEvents([])).toEqual({ visible: [], hiddenCount: 0 });
  });
});

describe("filterMonthSales", () => {
  it("keeps sales overlapping the month and drops grid-only neighbours", () => {
    const sales = [
      sale("inside", "2026-10-05T00:00:00Z", "2026-10-06T00:00:00Z"),
      // 2026-09-28 JST only: visible in the grid, not in October.
      sale("prevOnly", "2026-09-27T15:00:00Z", "2026-09-28T15:00:00Z", true),
      // 2026-11-02 JST only.
      sale("nextOnly", "2026-11-01T15:00:00Z", "2026-11-02T15:00:00Z", true),
      // Ends exactly at 2026-10-01 00:00 JST.
      sale("endsAtStart", "2026-09-29T15:00:00Z", "2026-09-30T15:00:00Z", true),
      // Starts exactly at 2026-11-01 00:00 JST.
      sale("startsAtEnd", "2026-10-31T15:00:00Z", "2026-11-01T15:00:00Z", true),
      // Spans the month boundary.
      sale("spanning", "2026-09-29T00:00:00Z", "2026-10-02T00:00:00Z"),
    ];
    expect(filterMonthSales(sales, OCT_2026).map((s) => s.id)).toEqual(["inside", "spanning"]);
  });
});

describe("calendarHref", () => {
  it("builds month links with an optional retailer", () => {
    expect(calendarHref(OCT_2026)).toBe("/calendar?year=2026&month=10");
    expect(calendarHref(OCT_2026, "amazon")).toBe("/calendar?year=2026&month=10&retailer=amazon");
    expect(calendarHref(null)).toBe("/calendar");
    expect(calendarHref(null, "rakuten")).toBe("/calendar?retailer=rakuten");
  });
});

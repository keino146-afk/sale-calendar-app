import { describe, expect, it } from "vitest";
import {
  classifySales,
  formatPublicSalePeriod,
  formatSalePeriod,
  getSaleTimingState,
  isSaleActive,
  isSaleUpcoming,
  SALE_TIMING_LABELS,
  UPCOMING_DAYS,
} from "./sale-display";

const NOW = new Date("2026-10-10T03:00:00.000Z"); // 2026-10-10 12:00 JST
const NOW_ISO = NOW.toISOString();
const IN_14_DAYS = new Date(NOW.getTime() + 14 * 24 * 60 * 60 * 1000).toISOString();

function sale(startsAt: string, endsAt: string, isDateOnly = false) {
  return { startsAt, endsAt, isDateOnly };
}

describe("isSaleActive", () => {
  it("is active when startsAt equals now", () => {
    expect(isSaleActive(sale(NOW_ISO, "2026-10-11T00:00:00Z"), NOW)).toBe(true);
  });

  it("is not active when endsAt equals now (exclusive end)", () => {
    expect(isSaleActive(sale("2026-10-01T00:00:00Z", NOW_ISO), NOW)).toBe(false);
  });

  it("is not active before it starts", () => {
    expect(isSaleActive(sale("2026-10-10T03:00:01Z", "2026-10-11T00:00:00Z"), NOW)).toBe(false);
  });
});

describe("isSaleUpcoming", () => {
  it("is not upcoming when startsAt equals now", () => {
    expect(isSaleUpcoming(sale(NOW_ISO, "2026-10-11T00:00:00Z"), NOW, 14)).toBe(false);
  });

  it("is upcoming just after now", () => {
    expect(isSaleUpcoming(sale("2026-10-10T03:00:01Z", "2026-10-11T00:00:00Z"), NOW, 14)).toBe(
      true,
    );
  });

  it("excludes a sale starting exactly now + 14 days", () => {
    expect(isSaleUpcoming(sale(IN_14_DAYS, "2026-12-01T00:00:00Z"), NOW, 14)).toBe(false);
  });

  it("includes a sale starting just before now + 14 days", () => {
    const justBefore = new Date(new Date(IN_14_DAYS).getTime() - 1).toISOString();
    expect(isSaleUpcoming(sale(justBefore, "2026-12-01T00:00:00Z"), NOW, 14)).toBe(true);
  });
});

describe("classifySales", () => {
  it("splits sales into active and upcoming and drops others", () => {
    const active = { id: "a", ...sale("2026-10-09T00:00:00Z", "2026-10-12T00:00:00Z") };
    const upcoming = { id: "u", ...sale("2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z") };
    const ended = { id: "e", ...sale("2026-10-01T00:00:00Z", NOW_ISO) };
    const tooFar = { id: "f", ...sale(IN_14_DAYS, "2026-12-01T00:00:00Z") };

    const result = classifySales([active, upcoming, ended, tooFar], NOW);

    expect(result.active.map((s) => s.id)).toEqual(["a"]);
    expect(result.upcoming.map((s) => s.id)).toEqual(["u"]);
  });

  it("uses 14 days by default", () => {
    expect(UPCOMING_DAYS).toBe(14);
  });
});

describe("formatSalePeriod", () => {
  it("shows the last day for date-only sales (exclusive end minus one day)", () => {
    // 2026-11-01 00:00 JST to 2026-11-04 00:00 JST => last day 11/3
    expect(
      formatSalePeriod(sale("2026-10-31T15:00:00Z", "2026-11-03T15:00:00Z", true)),
    ).toBe("11/1(日) 〜 11/3(火)");
  });

  it("shows a single day for a one-day date-only sale", () => {
    expect(
      formatSalePeriod(sale("2026-10-31T15:00:00Z", "2026-11-01T15:00:00Z", true)),
    ).toBe("11/1(日)");
  });

  it("shows the stored exclusive end time as-is for timed sales", () => {
    // 2026-11-04 20:00 JST to 2026-11-11 02:00 JST
    expect(formatSalePeriod(sale("2026-11-04T11:00:00Z", "2026-11-10T17:00:00Z"))).toBe(
      "11/4 20:00 〜 11/11 02:00",
    );
  });

  it("does not subtract a minute from timed sales", () => {
    expect(formatSalePeriod(sale("2026-11-04T11:00:00Z", "2026-11-10T16:59:00Z"))).toBe(
      "11/4 20:00 〜 11/11 01:59",
    );
  });
});

describe("formatPublicSalePeriod", () => {
  it("shows the last running minute of a timed sale (midnight end)", () => {
    // 2026-10-13 00:00 JST to 2026-10-16 00:00 JST (exclusive)
    expect(formatPublicSalePeriod(sale("2026-10-12T15:00:00Z", "2026-10-15T15:00:00Z"))).toBe(
      "10/13 00:00 〜 10/15 23:59",
    );
  });

  it("shows the last running minute of a timed sale (daytime end)", () => {
    // 2026-10-14 20:00 JST to 2026-10-17 10:00 JST (exclusive)
    expect(formatPublicSalePeriod(sale("2026-10-14T11:00:00Z", "2026-10-17T01:00:00Z"))).toBe(
      "10/14 20:00 〜 10/17 09:59",
    );
  });

  it("crosses a month boundary", () => {
    // ... to 2026-11-01 00:00 JST (exclusive)
    expect(formatPublicSalePeriod(sale("2026-10-27T11:00:00Z", "2026-10-31T15:00:00Z"))).toBe(
      "10/27 20:00 〜 10/31 23:59",
    );
  });

  it("crosses a year boundary", () => {
    // ... to 2027-01-01 00:00 JST (exclusive)
    expect(formatPublicSalePeriod(sale("2026-12-25T15:00:00Z", "2026-12-31T15:00:00Z"))).toBe(
      "12/26 00:00 〜 12/31 23:59",
    );
  });

  it("formats in JST regardless of the UTC date", () => {
    // 2026-10-16 08:30 JST (exclusive) is 2026-10-15 23:30 UTC
    expect(formatPublicSalePeriod(sale("2026-10-15T15:00:00Z", "2026-10-15T23:30:00Z"))).toBe(
      "10/16 00:00 〜 10/16 08:29",
    );
  });

  it("keeps the start time unchanged", () => {
    expect(formatPublicSalePeriod(sale("2026-11-04T11:00:00Z", "2026-11-10T17:00:00Z"))).toMatch(/^11\/4 20:00 〜 /);
  });

  it("shows a one-minute sale as a single minute on both sides", () => {
    expect(formatPublicSalePeriod(sale("2026-11-04T11:00:00Z", "2026-11-04T11:01:00Z"))).toBe(
      "11/4 20:00 〜 11/4 20:00",
    );
  });

  it("keeps the minute that contains a seconds-precision end", () => {
    // Exclusive end 10:00:30 JST: the sale still runs during 10:00.
    expect(formatPublicSalePeriod(sale("2026-10-14T11:00:00Z", "2026-10-17T01:00:30Z"))).toBe(
      "10/14 20:00 〜 10/17 10:00",
    );
  });

  it("matches formatSalePeriod for date-only sales", () => {
    for (const dateOnly of [
      sale("2026-10-31T15:00:00Z", "2026-11-03T15:00:00Z", true),
      sale("2026-10-31T15:00:00Z", "2026-11-01T15:00:00Z", true),
    ]) {
      expect(formatPublicSalePeriod(dateOnly)).toBe(formatSalePeriod(dateOnly));
    }
    expect(formatPublicSalePeriod(sale("2026-10-31T15:00:00Z", "2026-11-03T15:00:00Z", true))).toBe(
      "11/1(日) 〜 11/3(火)",
    );
  });

  it("does not mutate the sale it formats", () => {
    const timed = Object.freeze(sale("2026-10-12T15:00:00Z", "2026-10-15T15:00:00Z"));
    formatPublicSalePeriod(timed);
    expect(timed).toEqual({ startsAt: "2026-10-12T15:00:00Z", endsAt: "2026-10-15T15:00:00Z", isDateOnly: false });
  });

  it("leaves the admin formatter showing the stored exclusive end", () => {
    expect(formatSalePeriod(sale("2026-10-12T15:00:00Z", "2026-10-15T15:00:00Z"))).toBe(
      "10/13 00:00 〜 10/16 00:00",
    );
  });
});

describe("getSaleTimingState", () => {
  // Timed: 2026-10-13 00:00 JST to an exclusive end of 2026-10-16 00:00 JST.
  const TIMED = sale("2026-10-12T15:00:00.000Z", "2026-10-15T15:00:00.000Z");
  const at = (iso: string) => new Date(iso);

  it.each([
    ["one second before the start", "2026-10-12T14:59:59.000Z", "upcoming"],
    ["the exact start", "2026-10-12T15:00:00.000Z", "active"],
    ["during the sale", "2026-10-14T03:00:00.000Z", "active"],
    ["one millisecond before the exclusive end", "2026-10-15T14:59:59.999Z", "active"],
    ["the exact stored end", "2026-10-15T15:00:00.000Z", "ended"],
    ["one second after the end", "2026-10-15T15:00:01.000Z", "ended"],
  ])("timed sale at %s", (_label, now, expected) => {
    expect(getSaleTimingState(TIMED, at(now))).toBe(expected);
  });

  // Date-only 10/15 only: 10/15 00:00 JST to 10/16 00:00 JST.
  const ONE_DAY = sale("2026-10-14T15:00:00.000Z", "2026-10-15T15:00:00.000Z", true);

  it.each([
    ["the previous day 23:59:59 JST", "2026-10-14T14:59:59.000Z", "upcoming"],
    ["00:00 JST on the day", "2026-10-14T15:00:00.000Z", "active"],
    ["23:59:59.999 JST on the day", "2026-10-15T14:59:59.999Z", "active"],
    ["the next day 00:00 JST", "2026-10-15T15:00:00.000Z", "ended"],
  ])("date-only sale at %s", (_label, now, expected) => {
    expect(getSaleTimingState(ONE_DAY, at(now))).toBe(expected);
  });

  it("compares instants regardless of the offset the timestamps are written with", () => {
    const jstWritten = sale("2026-10-13T00:00:00+09:00", "2026-10-16T00:00:00+09:00");
    expect(getSaleTimingState(jstWritten, at("2026-10-15T14:59:59.999Z"))).toBe("active");
    expect(getSaleTimingState(jstWritten, at("2026-10-15T15:00:00.000Z"))).toBe("ended");
  });

  it("ends at the stored end while the public period still shows the minute before", () => {
    // Stored end 10/16 00:00 JST is shown as 10/15 23:59 on public pages.
    expect(formatPublicSalePeriod(TIMED)).toBe("10/13 00:00 〜 10/15 23:59");
    expect(getSaleTimingState(TIMED, at("2026-10-15T14:59:00.000Z"))).toBe("active");
    expect(getSaleTimingState(TIMED, at("2026-10-15T15:00:00.000Z"))).toBe("ended");
  });

  it("agrees with isSaleActive and classifySales at every boundary", () => {
    const instants = [
      "2026-10-12T14:59:59.999Z",
      "2026-10-12T15:00:00.000Z",
      "2026-10-15T14:59:59.999Z",
      "2026-10-15T15:00:00.000Z",
    ].map(at);
    for (const now of instants) {
      const state = getSaleTimingState(TIMED, now);
      expect(isSaleActive(TIMED, now)).toBe(state === "active");
      const { active, upcoming } = classifySales([TIMED], now);
      expect(active.length === 1).toBe(state === "active");
      if (upcoming.length === 1) expect(state).toBe("upcoming");
      if (state === "ended") expect(active.length + upcoming.length).toBe(0);
    }
  });

  it("labels the states for public pages without workflow words", () => {
    expect(SALE_TIMING_LABELS).toEqual({ upcoming: "開催予定", active: "開催中", ended: "終了しました" });
  });
});

import { describe, expect, it } from "vitest";
import {
  classifySales,
  formatSalePeriod,
  isSaleActive,
  isSaleUpcoming,
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

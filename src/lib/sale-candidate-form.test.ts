import { describe, expect, it } from "vitest";
import {
  saleFormDefaultsFromPeriod,
  toJstDateTimeLocal,
  isOnOfficialDomain,
  isValidTitle,
  parseJstDateTime,
  parsePeriodMode,
  parseSaleCandidateForm,
  parseSourceUrl,
} from "./sale-candidate-form";

const RETAILER_ID = "11111111-1111-4111-8111-111111111111";

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

const BASE = {
  retailerId: RETAILER_ID,
  title: "  スーパーSALE  ",
  description: "",
  sourceUrl: "https://www.rakuten.co.jp/event/",
  sourceCheckedAt: "2026-10-11T09:30",
};

describe("parsePeriodMode", () => {
  it("defaults to date and accepts datetime", () => {
    expect(parsePeriodMode("datetime")).toBe("datetime");
    for (const value of [undefined, "date", "time", "", ["datetime", "datetime"]]) {
      expect(parsePeriodMode(value)).toBe("date");
    }
  });
});

describe("date-only mode", () => {
  it("stores JST midnight and the next day as the exclusive end", () => {
    const result = parseSaleCandidateForm(form({ ...BASE, startDate: "2026-10-11", endDate: "2026-10-13" }), "date");

    expect(result).toEqual({
      ok: true,
      value: {
        retailerId: RETAILER_ID,
        title: "スーパーSALE",
        description: null,
        startsAt: new Date("2026-10-10T15:00:00.000Z"), // 10/11 00:00 JST
        endsAt: new Date("2026-10-13T15:00:00.000Z"), // 10/14 00:00 JST (exclusive)
        isDateOnly: true,
        sourceUrl: "https://www.rakuten.co.jp/event/",
        sourceCheckedAt: new Date("2026-10-11T00:30:00.000Z"),
      },
    });
  });

  it("allows a one-day sale", () => {
    const result = parseSaleCandidateForm(form({ ...BASE, startDate: "2026-10-11", endDate: "2026-10-11" }), "date");
    expect(result.ok && result.value.endsAt.getTime() - result.value.startsAt.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  it("handles month and year ends", () => {
    const result = parseSaleCandidateForm(form({ ...BASE, startDate: "2026-12-31", endDate: "2026-12-31" }), "date");
    expect(result.ok && result.value.endsAt.toISOString()).toBe("2026-12-31T15:00:00.000Z"); // 2027/1/1 00:00 JST
  });

  it.each([
    ["start after end", "2026-10-13", "2026-10-11"],
    ["invalid date", "2026-02-30", "2026-03-01"],
    ["bad format", "2026/10/11", "2026-10-12"],
    ["missing end", "2026-10-11", ""],
    ["out of range", "2019-12-31", "2020-01-01"],
  ])("rejects %s", (_label, startDate, endDate) => {
    expect(parseSaleCandidateForm(form({ ...BASE, startDate, endDate }), "date")).toEqual({
      ok: false,
      error: "period",
    });
  });

  it("ignores datetime fields in date mode", () => {
    const result = parseSaleCandidateForm(
      form({ ...BASE, startsAt: "2026-10-11T10:00", endsAt: "2026-10-12T10:00" }),
      "date",
    );
    expect(result).toEqual({ ok: false, error: "period" });
  });
});

describe("timed mode", () => {
  it("reads datetime-local values as JST and keeps the end as entered", () => {
    const result = parseSaleCandidateForm(
      form({ ...BASE, startsAt: "2026-11-04T20:00", endsAt: "2026-11-11T01:59" }),
      "datetime",
    );

    expect(result.ok && result.value).toMatchObject({
      startsAt: new Date("2026-11-04T11:00:00.000Z"),
      endsAt: new Date("2026-11-10T16:59:00.000Z"),
      isDateOnly: false,
    });
  });

  it.each([
    ["end equal to start", "2026-11-04T20:00", "2026-11-04T20:00"],
    ["end before start", "2026-11-04T20:00", "2026-11-04T19:59"],
    ["invalid hour", "2026-11-04T24:00", "2026-11-05T01:00"],
    ["date only value", "2026-11-04", "2026-11-05"],
  ])("rejects %s", (_label, startsAt, endsAt) => {
    expect(parseSaleCandidateForm(form({ ...BASE, startsAt, endsAt }), "datetime")).toEqual({
      ok: false,
      error: "period",
    });
  });

  it("does not depend on the process time zone", () => {
    expect(parseJstDateTime("2026-01-01T00:00")?.toISOString()).toBe("2025-12-31T15:00:00.000Z");
    expect(parseJstDateTime("2026-01-01T00:00:30")?.toISOString()).toBe("2025-12-31T15:00:30.000Z");
  });
});

describe("common fields", () => {
  const DATES = { startDate: "2026-10-11", endDate: "2026-10-12" };

  it.each([
    ["missing retailer", { retailerId: "" }],
    ["malformed retailer", { retailerId: "rakuten" }],
  ])("rejects a %s", (_label, override) => {
    expect(parseSaleCandidateForm(form({ ...BASE, ...DATES, ...override }), "date")).toEqual({
      ok: false,
      error: "retailer",
    });
  });

  it.each([
    ["empty", ""],
    ["blank", " 　\t"],
    ["too long", "あ".repeat(201)],
  ])("rejects an %s title", (_label, title) => {
    expect(parseSaleCandidateForm(form({ ...BASE, ...DATES, title }), "date")).toEqual({ ok: false, error: "title" });
  });

  it("counts title length without whitespace like the database", () => {
    expect(isValidTitle(`${"あ".repeat(200)}   `)).toBe(true);
    expect(isValidTitle("あ ".repeat(200))).toBe(true);
    expect(isValidTitle("あ".repeat(201))).toBe(false);
  });

  it("stores a blank description as null and trims a real one", () => {
    const blank = parseSaleCandidateForm(form({ ...BASE, ...DATES, description: " \n " }), "date");
    expect(blank.ok && blank.value.description).toBeNull();
    const real = parseSaleCandidateForm(form({ ...BASE, ...DATES, description: " 最大50%OFF\n" }), "date");
    expect(real.ok && real.value.description).toBe("最大50%OFF");
    expect(parseSaleCandidateForm(form({ ...BASE, ...DATES, description: "あ".repeat(5001) }), "date")).toEqual({
      ok: false,
      error: "description",
    });
  });

  it.each([
    "",
    "www.rakuten.co.jp",
    "http://www.rakuten.co.jp/",
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "https://user:pass@www.rakuten.co.jp/",
    `https://www.rakuten.co.jp/${"a".repeat(2048)}`,
  ])("rejects source URL %j", (sourceUrl) => {
    expect(parseSaleCandidateForm(form({ ...BASE, ...DATES, sourceUrl }), "date")).toEqual({
      ok: false,
      error: "source_url",
    });
  });

  it("accepts and trims an https source URL", () => {
    expect(parseSourceUrl("  https://event.rakuten.co.jp/super-sale/  ")).toBe("https://event.rakuten.co.jp/super-sale/");
  });

  it.each([
    "https://www.rakuten.co.jp:8443/",
    "https://www.aboutamazon.jp:443/news/a/b",
    "https://www.amazon.co.jp:/",
    "https://user@www.aboutamazon.jp/news/a/b",
    "http://www.aboutamazon.jp/news/a/b",
    "https://www.amazon.co.jp/a b",
    "https://www.amazon.co.jp/a\tb",
    "https://www.amazon.co.jp/a\u0000b",
  ])("rejects source URL %j (port, credentials, http, whitespace or control)", (raw) => {
    expect(parseSourceUrl(raw)).toBeNull();
  });

  it.each(["", "2026-10-11", "2026-13-01T10:00", "yesterday"])("rejects checked-at %j", (sourceCheckedAt) => {
    expect(parseSaleCandidateForm(form({ ...BASE, ...DATES, sourceCheckedAt }), "date")).toEqual({
      ok: false,
      error: "checked_at",
    });
  });
});

describe("isOnOfficialDomain", () => {
  it("accepts the official host and its subdomains", () => {
    expect(isOnOfficialDomain("https://www.rakuten.co.jp/x", "https://www.rakuten.co.jp/")).toBe(true);
    expect(isOnOfficialDomain("https://event.rakuten.co.jp/x", "https://www.rakuten.co.jp/")).toBe(true);
    expect(isOnOfficialDomain("https://rakuten.co.jp/", "https://www.rakuten.co.jp/")).toBe(true);
  });

  it("rejects other domains and look-alikes", () => {
    expect(isOnOfficialDomain("https://www.amazon.co.jp/", "https://www.rakuten.co.jp/")).toBe(false);
    expect(isOnOfficialDomain("https://rakuten.co.jp.evil.example/", "https://www.rakuten.co.jp/")).toBe(false);
    expect(isOnOfficialDomain("https://fakerakuten.co.jp/", "https://www.rakuten.co.jp/")).toBe(false);
  });
});

describe("saleFormDefaultsFromPeriod", () => {
  const base = {
    retailerId: RETAILER_ID,
    title: "プライム感謝祭",
    description: null,
    sourceUrl: "https://www.amazon.co.jp/primeday",
    sourceCheckedAt: new Date("2026-10-02T03:00:00Z"),
  };

  it("converts a date-only period to inclusive JST dates", () => {
    expect(
      saleFormDefaultsFromPeriod({
        ...base,
        startsAt: new Date("2026-10-10T15:00:00Z"),
        endsAt: new Date("2026-10-13T15:00:00Z"),
      }),
    ).toEqual({
      retailerId: RETAILER_ID,
      title: "プライム感謝祭",
      description: "",
      startDate: "2026-10-11",
      endDate: "2026-10-13",
      startsAt: "2026-10-11T00:00",
      endsAt: "2026-10-14T00:00",
      sourceUrl: "https://www.amazon.co.jp/primeday",
      sourceCheckedAt: "2026-10-02T12:00",
    });
  });

  it("keeps a timed end on its own day", () => {
    const defaults = saleFormDefaultsFromPeriod({
      ...base,
      startsAt: new Date("2026-10-15T15:00:00Z"),
      endsAt: new Date("2026-10-19T14:59:00Z"),
    });
    expect(defaults.endDate).toBe("2026-10-19");
    expect(defaults.endsAt).toBe("2026-10-19T23:59");
  });

  it("round-trips through the form parser", () => {
    const startsAt = new Date("2026-10-10T15:00:00Z");
    const endsAt = new Date("2026-10-13T15:00:00Z");
    const d = saleFormDefaultsFromPeriod({ ...base, startsAt, endsAt });
    const result = parseSaleCandidateForm(
      form({ retailerId: d.retailerId, title: d.title, description: d.description, startDate: d.startDate, endDate: d.endDate, sourceUrl: d.sourceUrl, sourceCheckedAt: d.sourceCheckedAt }),
      "date",
    );
    expect(result.ok && [result.value.startsAt, result.value.endsAt]).toEqual([startsAt, endsAt]);
  });

  it("formats datetime-local values in JST", () => {
    expect(toJstDateTimeLocal(new Date("2025-12-31T15:05:00Z"))).toBe("2026-01-01T00:05");
  });
});

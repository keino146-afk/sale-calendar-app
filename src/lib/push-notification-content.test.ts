import { describe, expect, it } from "vitest";
import {
  buildPushNotificationContent,
  sanitizePushText,
  type PushContentOptions,
  type PushContentSale,
} from "./push-notification-content";
import {
  groupSendablePushNotifications,
  parseInstantMicros,
  schedulePushNotifications,
  type PushNotificationKind,
} from "./push-notification-schedule";

// 11/10 20:00 JST to the exclusive end 11/15 02:00 JST (last minute 01:59).
const SALE: PushContentSale = {
  retailerName: "〇〇ストア",
  title: "秋の大感謝祭",
  startsAt: "2026-11-10T20:00:00+09:00",
  endsAt: "2026-11-15T02:00:00+09:00",
  isDateOnly: false,
};

function content(kinds: PushNotificationKind[], sale: PushContentSale = SALE, options?: PushContentOptions) {
  const result = buildPushNotificationContent(kinds, sale, options);
  if (!result.ok) throw new Error(`unexpected error: ${result.error}`);
  return result;
}

function text(kinds: PushNotificationKind[], sale: PushContentSale = SALE) {
  const { title, body } = content(kinds, sale);
  return [title, body];
}

function length(value: string): number {
  return Array.from(new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(value)).length;
}

describe("buildPushNotificationContent: approved texts", () => {
  it("renders each of the 5 kinds with its approved title and body", () => {
    expect(text(["new-sale"])).toEqual([
      "新しいセール情報",
      "〇〇ストア「秋の大感謝祭」の開催期間は2026/11/10 20:00〜2026/11/15 01:59です。",
    ]);
    expect(text(["one-day-before-start"])).toEqual([
      "まもなくセール開始",
      "〇〇ストア「秋の大感謝祭」は2026/11/10 20:00から開催予定です。",
    ]);
    expect(text(["at-start"])).toEqual(["セール開始", "〇〇ストア「秋の大感謝祭」開催中！"]);
    expect(text(["one-day-before-end"])).toEqual([
      "セール終了が近づいています",
      "〇〇ストア「秋の大感謝祭」は2026/11/15 01:59までです。",
    ]);
    expect(text(["two-hours-before-end"])).toEqual([
      "まもなくセール終了",
      "〇〇ストア「秋の大感謝祭」は2026/11/15 01:59までです。",
    ]);
  });

  it("reports nothing checked when no length is given", () => {
    expect(content(["at-start"])).toMatchObject({ truncated: false, withinBudget: null });
  });
});

describe("buildPushNotificationContent: dates", () => {
  it("shows a timed sale with 2-digit hours, 00:00 included, and the last running minute of the exclusive end", () => {
    const midnight = { ...SALE, startsAt: "2026-11-10T00:00:00+09:00", endsAt: "2026-11-16T00:00:00+09:00" };
    expect(content(["new-sale"], midnight).body).toBe(
      "〇〇ストア「秋の大感謝祭」の開催期間は2026/11/10 00:00〜2026/11/15 23:59です。",
    );
  });

  it("shows a date-only sale without times, ending on its last day, across a year", () => {
    const dateOnly = {
      ...SALE,
      startsAt: "2026-12-30T00:00:00+09:00",
      endsAt: "2027-01-04T00:00:00+09:00",
      isDateOnly: true,
    };
    expect(content(["new-sale"], dateOnly).body).toBe(
      "〇〇ストア「秋の大感謝祭」の開催期間は2026/12/30〜2027/1/3です。",
    );
    expect(content(["one-day-before-start"], dateOnly).body).toBe("〇〇ストア「秋の大感謝祭」は2026/12/30から開催予定です。");
    expect(content(["one-day-before-end"], dateOnly).body).toBe("〇〇ストア「秋の大感謝祭」は2027/1/3までです。");
  });

  it("rejects a date-only sale whose bounds are not JST midnight instead of guessing", () => {
    expect(
      buildPushNotificationContent(["new-sale"], { ...SALE, isDateOnly: true }),
    ).toEqual({ ok: false, error: "date-only-not-midnight" });
    expect(
      buildPushNotificationContent(["new-sale"], {
        ...SALE,
        startsAt: "2026-11-10T00:00:00+09:00",
        endsAt: "2026-11-15T00:00:00.000001+09:00",
        isDateOnly: true,
      }),
    ).toEqual({ ok: false, error: "date-only-not-midnight" });
  });

  it.each([
    ["a start without an offset", { startsAt: "2026-11-10T20:00:00" }, "invalid-starts-at"],
    ["an impossible end", { endsAt: "2026-02-30T00:00:00Z" }, "invalid-ends-at"],
    ["an end not after the start", { endsAt: "2026-11-10T20:00:00+09:00" }, "ends-not-after-starts"],
    ["a non-boolean date-only flag", { isDateOnly: "true" as unknown as boolean }, "invalid-is-date-only"],
  ])("rejects %s", (_label, change, error) => {
    expect(buildPushNotificationContent(["new-sale"], { ...SALE, ...change })).toEqual({ ok: false, error });
  });
});

describe("buildPushNotificationContent: grouped kinds", () => {
  it("prefers new-sale over any other kind in the group", () => {
    expect(text(["new-sale", "at-start"])[1]).toBe(text(["new-sale"])[1]);
    expect(text(["new-sale", "one-day-before-end"])).toEqual(text(["new-sale"]));
  });

  it("adds the end to at-start when an end notice is due with it", () => {
    for (const end of ["one-day-before-end", "two-hours-before-end"] as const) {
      expect(text(["at-start", end])).toEqual(["セール開始", "〇〇ストア「秋の大感謝祭」開催中！終了は2026/11/15 01:59です。"]);
    }
  });

  it("does not depend on the order of the kinds", () => {
    expect(text(["one-day-before-end", "at-start"])).toEqual(text(["at-start", "one-day-before-end"]));
  });

  // A-1 is used as is: its groups hold only the kinds still sendable, so an
  // expired kind cannot come back in the text.
  it("uses the kinds A-1 still offers: at-start expired leaves the end notice alone", () => {
    const schedule = schedulePushNotifications({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      startsAt: "2026-11-10T00:00:00+09:00",
      endsAt: "2026-11-11T00:00:00+09:00",
      publishedAt: "2026-11-01T10:00:00+09:00",
    });
    if (!schedule.ok) throw new Error(schedule.error);
    const sale = { ...SALE, startsAt: "2026-11-10T00:00:00+09:00", endsAt: "2026-11-11T00:00:00+09:00" };

    const [atStart] = groupSendablePushNotifications(schedule.notifications, parseInstantMicros("2026-11-09T15:00:00Z")!);
    expect(atStart.kinds).toEqual(["at-start", "one-day-before-end"]);
    expect(text(atStart.kinds, sale)[1]).toBe("〇〇ストア「秋の大感謝祭」開催中！終了は2026/11/10 23:59です。");

    // 20 minutes later at-start (15 min) has expired; 1 day before the end (1 h) has not.
    const [later] = groupSendablePushNotifications(schedule.notifications, parseInstantMicros("2026-11-09T15:20:00Z")!);
    expect(later.kinds).toEqual(["one-day-before-end"]);
    expect(text(later.kinds, sale)).toEqual(["セール終了が近づいています", "〇〇ストア「秋の大感謝祭」は2026/11/10 23:59までです。"]);
  });

  it.each([
    ["no kind", []],
    ["a removed kind", ["three-days-before-start"]],
    ["the same kind twice", ["at-start", "at-start"]],
  ])("rejects %s", (_label, kinds) => {
    expect(buildPushNotificationContent(kinds as PushNotificationKind[], SALE)).toEqual({ ok: false, error: "invalid-kinds" });
  });
});

describe("buildPushNotificationContent: body length", () => {
  // Body: 店「ABCDEFGHIJ」開催中！ (17 graphemes); all but the 10 of the sale title are fixed.
  const SHORT = { ...SALE, retailerName: "店", title: "ABCDEFGHIJ" };

  it("keeps a body that fits, up to exactly the limit", () => {
    expect(content(["at-start"], SHORT, { maxBodyGraphemes: 17 })).toEqual({
      ok: true,
      title: "セール開始",
      body: "店「ABCDEFGHIJ」開催中！",
      truncated: false,
      withinBudget: true,
    });
  });

  it("shortens only the sale title, counting the ellipsis, when 1 grapheme over", () => {
    const result = content(["at-start"], SHORT, { maxBodyGraphemes: 16 });
    expect(result).toMatchObject({ body: "店「ABCDEFGH…」開催中！", truncated: true, withinBudget: true });
    expect(length(result.body)).toBe(16);
  });

  it("keeps the dates and the retailer when shortening", () => {
    const result = content(["new-sale"], { ...SALE, title: "とても長いセール名".repeat(10) }, { maxBodyGraphemes: 60 });
    expect(result.truncated).toBe(true);
    expect(result.body.startsWith("〇〇ストア「とても長い")).toBe(true);
    expect(result.body.endsWith("…」の開催期間は2026/11/10 20:00〜2026/11/15 01:59です。")).toBe(true);
    expect(length(result.body)).toBe(60);
  });

  it("never cuts an emoji, a flag or a combining sequence", () => {
    const emoji = { ...SHORT, title: "👨\u200D👩\u200D👧\u200D👦🇯🇵❤\uFE0Fe\u0301X" }; // 5 graphemes
    expect(content(["at-start"], emoji, { maxBodyGraphemes: 10 }).body).toBe("店「👨\u200D👩\u200D👧\u200D👦🇯🇵…」開催中！");
  });

  it("returns the full body marked as not fitting when even one sale-title grapheme would not fit", () => {
    // Fixed part 7 + 1 kept + ellipsis = 9: a limit of 8 cannot be met.
    expect(content(["at-start"], SHORT, { maxBodyGraphemes: 8 })).toMatchObject({
      body: "店「ABCDEFGHIJ」開催中！",
      truncated: false,
      withinBudget: false,
    });
    expect(content(["at-start"], SHORT, { maxBodyGraphemes: 9 }).body).toBe("店「A…」開催中！");
  });

  it("keeps a very long retailer name whole and reports that the body does not fit", () => {
    const longRetailer = { ...SALE, retailerName: "長い店舗名".repeat(40) };
    const result = content(["two-hours-before-end"], longRetailer, { maxBodyGraphemes: 50 });
    expect(result.withinBudget).toBe(false);
    expect(result.body).toBe(`${"長い店舗名".repeat(40)}「秋の大感謝祭」は2026/11/15 01:59までです。`);
  });

  // U+0600 (Arabic number sign) is a Prepend character, kept by sanitizing:
  // at the end of the sale title it joins the closing quote into one
  // grapheme, so the full body counts one fewer than its parts. The
  // shortened body has no such join and must still fit the limit.
  it("fits the limit when a grapheme joins the sale title to the closing quote", () => {
    const prepend = { ...SHORT, title: "ABCDEFGHI\u0600" };
    // Body: 店「ABCDEFGHI\u0600」開催中！ is 16 graphemes (the last title character joins 」).
    expect(length(content(["at-start"], prepend).body)).toBe(16);
    const result = content(["at-start"], prepend, { maxBodyGraphemes: 14 });
    expect(result).toEqual({
      ok: true,
      title: "セール開始",
      body: "店「ABCDEF…」開催中！",
      truncated: true,
      withinBudget: true,
    });
    expect(length(result.body)).toBe(14);
  });

  it("never shortens a long sale title when no limit is given", () => {
    const longTitle = "とても長いセール名".repeat(30); // 270 characters
    const result = content(["new-sale"], { ...SALE, title: longTitle });
    expect(result).toEqual({
      ok: true,
      title: "新しいセール情報",
      body: `〇〇ストア「${longTitle}」の開催期間は2026/11/10 20:00〜2026/11/15 01:59です。`,
      truncated: false,
      withinBudget: null,
    });
    expect(result.body).not.toContain("…");
  });

  it.each([[0], [-1], [1.5], [Number.NaN], [Number.POSITIVE_INFINITY], [null]])("rejects a length of %s", (max) => {
    expect(
      buildPushNotificationContent(["at-start"], SALE, { maxBodyGraphemes: max as unknown as number }),
    ).toEqual({ ok: false, error: "invalid-max-body-graphemes" });
  });
});

describe("sanitizePushText", () => {
  it("turns line breaks, tabs and whitespace runs (full-width too) into single spaces, trimmed", () => {
    expect(sanitizePushText("  秋の\r\n大\t感謝祭\u3000\u3000セール\u2028終了\n ")).toBe("秋の 大 感謝祭 セール 終了");
  });

  it("removes control, bidirectional and invisible spacing characters", () => {
    expect(sanitizePushText("A\u0000B\u0007C\u009FD")).toBe("ABCD");
    expect(sanitizePushText("A\u202EB\u2066C\u200FD")).toBe("ABCD");
    expect(sanitizePushText("A\u200BB\u2060C\uFEFFD")).toBe("ABCD");
  });

  it("keeps the parts emoji and combined characters are made of", () => {
    for (const value of [
      "👨\u200D👩\u200D👧\u200D👦", // ZWJ
      "a\u200Cb", // ZWNJ
      "☺\uFE0F", // variation selector
      "e\u0301", // combining mark
      "👍🏽", // skin tone
      "🇯🇵", // regional indicators
      "🏴\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}", // tag sequence flag
    ]) {
      expect(sanitizePushText(value)).toBe(value);
    }
  });

  it("replaces a lone surrogate with U+FFFD", () => {
    expect(sanitizePushText("A\uD800B")).toBe("A\uFFFDB");
  });

  it("does not normalize the text", () => {
    expect(sanitizePushText("ＳＡＬＥ\u3000ｶﾀｶﾅ")).toBe("ＳＡＬＥ ｶﾀｶﾅ");
  });

  it("rejects names that are empty once cleaned", () => {
    expect(buildPushNotificationContent(["at-start"], { ...SALE, retailerName: " \u200B\n" })).toEqual({
      ok: false,
      error: "invalid-retailer-name",
    });
    expect(buildPushNotificationContent(["at-start"], { ...SALE, title: "\u202E\t" })).toEqual({
      ok: false,
      error: "invalid-sale-title",
    });
  });

  it("does not change its input", () => {
    const sale = Object.freeze({ ...SALE });
    const kinds = Object.freeze(["at-start", "one-day-before-end"] as PushNotificationKind[]);
    buildPushNotificationContent(kinds, sale, Object.freeze({ maxBodyGraphemes: 10 }));
    expect(sale).toEqual(SALE);
    expect(kinds).toEqual(["at-start", "one-day-before-end"]);
  });
});

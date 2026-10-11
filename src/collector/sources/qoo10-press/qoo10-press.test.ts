import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateWriteInput, CandidateWriteOutcome, Fetcher, ParsedCandidate } from "../../contract";
import { runCollection } from "../../pipeline";
import { parseRssItems, RSS_MAX_BYTES, RSS_MAX_ITEMS, RssParseError } from "../../rss";
import { validateCandidate } from "../../validate";
import {
  isQoo10MegaSaleAnnouncement,
  QOO10_PRESS_PARSER_VERSION,
  QOO10_PRESS_SOURCE,
  qoo10PressAdapter,
  qoo10PressNormalizer,
} from "./adapter";
import { extractQoo10SaleDateRange } from "./date-range";

// Everything here runs on synthetic data: no request leaves the process.

const NOW = new Date("2026-12-01T00:00:00Z");
const FIXTURE = new URL("./__fixtures__/qoo10-press-synthetic.rdf", import.meta.url);
const ARTICLE = "https://prtimes.jp/main/html/rd/p/000009001.000022933.html";
const TIMED = "Qoo10、テスト用「メガ割」を2027年2月1日（月）17:00～2月10日（水）23:59に開催";

const jst = (iso: string) => new Date(`${iso}+09:00`);

function rdf(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel rdf:about="https://prtimes.jp/test"><title>テスト</title></channel>${items}</rdf:RDF>`;
}

function item(title: string, link = ARTICLE, description?: string): string {
  const desc = description === undefined ? "" : `<description>${description}</description>`;
  return `<item rdf:about="${link}"><title>${title}</title><link>${link}</link>${desc}</item>`;
}

function normalizeOne(title: string, link = ARTICLE, description: string | null = null) {
  const parsed: ParsedCandidate = {
    externalKey: link,
    sourceUrl: link,
    title,
    description,
    startsAt: null,
    endsAt: null,
    isDateOnly: null,
    evidenceExcerpt: title,
  };
  return qoo10PressNormalizer.normalize(parsed);
}

function validate(candidate: ParsedCandidate | null, now = NOW) {
  if (candidate === null) throw new Error("expected a candidate");
  return validateCandidate(candidate, { source: QOO10_PRESS_SOURCE, checkedAt: now, now });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RSS 1.0 (RDF) feeds in the generic reader", () => {
  it("reads items beside the channel, with dc:date and rdf:about", async () => {
    const items = parseRssItems(await readFile(FIXTURE, "utf8"));
    expect(items).toHaveLength(9);
    expect(items[0]).toEqual({
      title: TIMED,
      link: `${ARTICLE}?utm_source=rss&utm_medium=feed#top`,
      guid: ARTICLE,
      publishedAt: new Date("2026-11-20T02:00:00Z"),
      description: "これは完全なテスト用文章です。",
    });
  });

  it("matches RSS 1.0 elements by namespace, not prefix", () => {
    const body = `<r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:x="http://purl.org/rss/1.0/"><x:channel/><x:item><x:title>テスト</x:title></x:item><item><title>名前空間なし</title></item></r:RDF>`;
    expect(parseRssItems(body).map((i) => i.title)).toEqual(["テスト"]);
  });

  it.each([
    ["no channel", `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><item/></rdf:RDF>`],
    ["an RDF root in another namespace", `<rdf:RDF xmlns:rdf="https://evil.example/rdf#" xmlns="http://purl.org/rss/1.0/"><channel/></rdf:RDF>`],
    ["truncated XML", rdf(item(TIMED)).slice(0, -12)],
  ])("rejects %s", (_label, body) => {
    expect(() => parseRssItems(body)).toThrow(RssParseError);
  });

  it("applies the same declaration, size and item limits", () => {
    expect(() => parseRssItems(`<!DOCTYPE r [<!ENTITY x "x">]>${rdf(item("&x;"))}`)).toThrow(
      "DOCTYPE or ENTITY declarations are not accepted",
    );
    expect(() => parseRssItems(rdf(item(TIMED)) + `<!--${"x".repeat(RSS_MAX_BYTES)}-->`)).toThrow("feed too large");
    expect(parseRssItems(rdf(item(TIMED).repeat(RSS_MAX_ITEMS)))).toHaveLength(RSS_MAX_ITEMS);
    expect(() => parseRssItems(rdf(item(TIMED).repeat(RSS_MAX_ITEMS + 1)))).toThrow("too many items");
  });
});

describe("extractQoo10SaleDateRange", () => {
  it("reads date and time on both ends; the end minute becomes an exclusive end", () => {
    expect(extractQoo10SaleDateRange([TIMED])).toEqual({
      ok: true,
      range: {
        startsAt: jst("2027-02-01T17:00:00"),
        endsAt: jst("2027-02-11T00:00:00"),
        isDateOnly: false,
        text: "2027年2月1日(月)17:00~2月10日(水)23:59",
      },
    });
  });

  it("accepts kanji times and an explicit end year", () => {
    expect(extractQoo10SaleDateRange(["メガ割 2027年2月1日17時から2027年2月10日23時59分まで"])).toMatchObject({
      ok: true,
      range: { startsAt: jst("2027-02-01T17:00:00"), endsAt: jst("2027-02-11T00:00:00"), isDateOnly: false },
    });
  });

  it("reads dates only as a date-only period ending the day after the last day", () => {
    expect(extractQoo10SaleDateRange(["期間は2027年1月10日から1月15日までです"])).toEqual({
      ok: true,
      range: {
        startsAt: jst("2027-01-10T00:00:00"),
        endsAt: jst("2027-01-16T00:00:00"),
        isDateOnly: true,
        text: "2027年1月10日から1月15日まで",
      },
    });
  });

  it("carries the start year to an end without one, within the same range only", () => {
    expect(extractQoo10SaleDateRange(["2027年1月30日～2月2日"])).toMatchObject({
      ok: true,
      range: { startsAt: jst("2027-01-30T00:00:00"), endsAt: jst("2027-02-03T00:00:00") },
    });
  });

  it("never guesses the next year across a year boundary", () => {
    expect(extractQoo10SaleDateRange(["2027年12月28日から1月3日まで"])).toEqual({ ok: false, reason: "year_boundary" });
    // With both years stated the period is read as given.
    expect(extractQoo10SaleDateRange(["2027年12月28日から2028年1月3日まで"])).toMatchObject({
      ok: true,
      range: { endsAt: jst("2028-01-04T00:00:00") },
    });
  });

  it.each([
    ["start time, end date only", "2027年3月1日17:00から3月5日まで"],
    ["start date only, end time", "2027年3月1日から3月5日23:59まで"],
  ])("rejects mixed precision (%s)", (_label, text) => {
    expect(extractQoo10SaleDateRange([text])).toEqual({ ok: false, reason: "mixed_precision" });
  });

  it.each([
    ["no start year", "2月1日17:00～2月10日23:59"],
    ["an end hour without minutes", "2027年2月1日17時から2月10日23時まで"],
  ])("rejects an incomplete period (%s)", (_label, text) => {
    expect(extractQoo10SaleDateRange([text])).toEqual({ ok: false, reason: "incomplete_date" });
  });

  it.each([
    ["no dates", "Qoo10、テスト用「メガ割」を開催"],
    ["a start only", "Qoo10「メガポ」2027年10月1日より開催"],
    ["近日", "メガ割を近日開催"],
    ["来月", "メガ割を来月開催"],
  ])("finds no period with %s", (_label, text) => {
    expect(extractQoo10SaleDateRange([text])).toEqual({ ok: false, reason: "no_date_range" });
  });

  it.each([
    ["two different ranges", `${TIMED}、第2弾は2027年3月1日17:00～3月10日23:59`],
    ["another event's date", `${TIMED}（予告は1月25日）`],
  ])("rejects %s as ambiguous", (_label, text) => {
    expect(extractQoo10SaleDateRange([text])).toEqual({ ok: false, reason: "ambiguous_date_range" });
  });

  it("rejects title and description that disagree, accepts them when they agree", () => {
    expect(extractQoo10SaleDateRange([TIMED, "期間は2027年2月2日17:00～2月10日23:59です"])).toEqual({
      ok: false,
      reason: "ambiguous_date_range",
    });
    expect(extractQoo10SaleDateRange([TIMED, "期間は2027年2月1日17:00～2月10日23:59です"])).toMatchObject({ ok: true });
  });

  it.each([
    ["February 30", "2027年2月30日から3月2日まで"],
    ["hour 24", "2027年2月1日24:00～2月10日23:59"],
    ["minute 60", "2027年2月1日17:00～2月10日23:60"],
  ])("rejects an impossible date (%s)", (_label, text) => {
    expect(extractQoo10SaleDateRange([text])).toEqual({ ok: false, reason: "invalid_date" });
  });

  it("gives the same instants whatever the system time zone is", () => {
    const original = process.env.TZ;
    try {
      const results = ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Kiritimati"].map((zone) => {
        process.env.TZ = zone;
        const timed = extractQoo10SaleDateRange([TIMED]);
        const dateOnly = extractQoo10SaleDateRange(["2027年1月10日から1月15日まで"]);
        return JSON.stringify([timed, dateOnly]);
      });
      expect(new Set(results).size).toBe(1);
      expect(JSON.parse(results[0])).toMatchObject([
        { ok: true, range: { startsAt: "2027-02-01T08:00:00.000Z", endsAt: "2027-02-10T15:00:00.000Z" } },
        { ok: true, range: { startsAt: "2027-01-09T15:00:00.000Z", endsAt: "2027-01-15T15:00:00.000Z" } },
      ]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });
});

describe("Qoo10 Mega sale classification", () => {
  it.each([
    ["メガ割", "Qoo10、テスト用「メガ割」を開催"],
    ["メガポ", "Qoo10、テスト用「メガポ」を開催"],
    ["開催決定", "Qoo10 テスト用メガ割の開催決定"],
    ["full-width name", "Ｑｏｏ１０、テスト用メガ割を開催"],
  ])("treats a %s announcement as a candidate", (_label, title) => {
    expect(isQoo10MegaSaleAnnouncement(title)).toBe(true);
  });

  it.each([
    ["a commercial", "Qoo10「メガ割」テスト用の新CMを公開！2027年2月1日より開催"],
    ["a key visual", "Qoo10「メガポ」テスト用キービジュアル公開、メガポ開催"],
    ["a report", "Qoo10「メガ割」テスト開催レポート"],
    ["a past event", "Qoo10、テスト用メガ割を開催しました"],
    ["results", "Qoo10「メガ割」テスト開催の結果を発表"],
    ["a record", "Qoo10「メガ割」テスト開催で過去最高を更新"],
    ["a survey", "Qoo10、メガ割に関するテスト調査を開催"],
    ["no announcement", "Qoo10、メガ割のテスト用お得情報"],
    ["no Qoo10", "テスト用メガ割を開催"],
    ["ordinary news", "Qoo10、テスト用の新機能を提供開始"],
  ])("does not treat %s as a new sale", (_label, title) => {
    expect(isQoo10MegaSaleAnnouncement(title)).toBe(false);
    expect(normalizeOne(title)).toBeNull();
  });
});

describe("qoo10PressNormalizer and validation", () => {
  it("builds a candidate with the canonical article URL as identity", () => {
    expect(normalizeOne(TIMED, `${ARTICLE}?utm_source=rss&utm_medium=feed#top`, "<p>説明</p>")).toEqual({
      externalKey: ARTICLE,
      sourceUrl: ARTICLE,
      title: TIMED,
      description: null,
      startsAt: jst("2027-02-01T17:00:00"),
      endsAt: jst("2027-02-11T00:00:00"),
      isDateOnly: false,
      evidenceExcerpt: TIMED,
    });
  });

  it("passes a complete candidate with the Qoo10 parser version", () => {
    const result = validate(normalizeOne(TIMED));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ parserVersion: QOO10_PRESS_PARSER_VERSION, sourceCheckedAt: NOW, description: null });
      expect(result.value.contentHash).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("keeps the content hash stable and changes it with the period or title", () => {
    const hash = (title: string) => {
      const result = validate(normalizeOne(title));
      return result.ok ? result.value.contentHash : null;
    };
    expect(hash(TIMED)).toBe(hash(TIMED));
    expect(hash(TIMED.replace("2月10日", "2月11日"))).not.toBe(hash(TIMED));
    expect(hash(TIMED.replace("テスト用", "テスト版"))).not.toBe(hash(TIMED));
  });

  it.each([
    ["another publisher id", "https://prtimes.jp/main/html/rd/p/000009001.000099999.html"],
    ["a lookalike host", "https://prtimes.jp.evil.example/main/html/rd/p/000009001.000022933.html"],
    ["another host", "https://evil-prtimes.jp/main/html/rd/p/000009001.000022933.html"],
    ["a subdomain", "https://www.prtimes.jp/main/html/rd/p/000009001.000022933.html"],
    ["http", "http://prtimes.jp/main/html/rd/p/000009001.000022933.html"],
    ["credentials", "https://user@prtimes.jp/main/html/rd/p/000009001.000022933.html"],
    ["a port", "https://prtimes.jp:8443/main/html/rd/p/000009001.000022933.html"],
    ["another path", "https://prtimes.jp/main/html/searchrlp/company_id/22933"],
    ["a short release number", "https://prtimes.jp/main/html/rd/p/9001.000022933.html"],
    ["the publisher id in the wrong place", "https://prtimes.jp/main/html/rd/p/000022933.000009001.html"],
    ["the company feed", "https://prtimes.jp/companyrdf.php?company_id=22933"],
    ["a non-tracking query", `${ARTICLE}?page=2`],
    ["a malformed URL", "not a url"],
    ["no link", ""],
  ])("rejects a link with %s", (_label, link) => {
    const result = validate(normalizeOne(TIMED, link));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain("source_url");
  });

  it.each([
    ["no period", "Qoo10、テスト用「メガ割」を開催", "missing_period"],
    ["mixed precision", "Qoo10、テスト用「メガ割」を2027年3月1日17:00から3月5日まで開催", "missing_period"],
    ["longer than 31 days", "Qoo10、テスト用「メガ割」を2027年1月1日から2月5日まで開催", "period_too_long"],
    ["more than 400 days ahead", "Qoo10、テスト用「メガ割」を2028年3月1日から3月5日まで開催", "period_too_far"],
    ["already ended", "Qoo10、テスト用「メガ割」を2026年11月1日から11月5日まで開催", "already_ended"],
  ])("rejects a period with %s", (_label, title, issue) => {
    const result = validate(normalizeOne(title));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain(issue);
  });
});

function memoryWriter() {
  const rows = new Map<string, { firstHash: string; input: CandidateWriteInput }>();
  const submit = vi.fn(async (input: CandidateWriteInput): Promise<CandidateWriteOutcome> => {
    const key = `${input.sourceId}|${input.externalKey}`;
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, { firstHash: input.contentHash, input });
      return "inserted";
    }
    return input.contentHash === existing.firstHash ? "seen" : "changed";
  });
  return { writer: { submit }, rows, submit };
}

function syntheticFetcher(body: string): Fetcher & { fetch: ReturnType<typeof vi.fn> } {
  return {
    fetch: vi.fn(async (url: string) => ({ url, status: 200, contentType: "application/rdf+xml", body, fetchedAt: NOW })),
  };
}

describe("Qoo10 press pipeline (synthetic end to end)", () => {
  it("submits only complete eBay Japan Mega sale announcements, without any network access", async () => {
    const networkFetch = vi.spyOn(globalThis, "fetch");
    const { writer, rows } = memoryWriter();
    const fetcher = syntheticFetcher(await readFile(FIXTURE, "utf8"));

    const summary = await runCollection({ adapter: qoo10PressAdapter, fetcher, writer, now: () => NOW });

    expect(networkFetch).not.toHaveBeenCalled();
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      sourceId: "qoo10-ebay-japan-press",
      parserVersion: "qoo10-ebay-japan-press-v1",
      failure: null,
      discovered: 9,
      ignored: 4,
      inserted: 2,
      rejected: 3,
      writeErrors: 0,
      rejectedIssues: { source_url: 1, missing_period: 2 },
    });
    expect([...rows.values()].map(({ input }) => input)).toEqual([
      expect.objectContaining({
        sourceId: "qoo10-ebay-japan-press",
        externalKey: ARTICLE,
        startsAt: jst("2027-02-01T17:00:00"),
        endsAt: jst("2027-02-11T00:00:00"),
        isDateOnly: false,
        description: null,
        sourceCheckedAt: NOW,
      }),
      expect.objectContaining({
        externalKey: "https://prtimes.jp/main/html/rd/p/000009002.000022933.html",
        startsAt: jst("2027-01-10T00:00:00"),
        endsAt: jst("2027-01-16T00:00:00"),
        isDateOnly: true,
        evidenceExcerpt: "Qoo10、テスト用「メガポ」を開催\n2027年1月10日から1月15日まで",
      }),
    ]);
    for (const { input } of rows.values()) {
      expect(Object.keys(input)).not.toContain("status");
      expect(JSON.stringify(input)).not.toMatch(/<[a-z]/i);
    }
  });

  it("treats the same canonical link as one candidate", async () => {
    const { writer, rows } = memoryWriter();
    const body = rdf(item(TIMED, `${ARTICLE}?utm_source=rss`) + item(TIMED, `${ARTICLE}#top`));
    const summary = await runCollection({ adapter: qoo10PressAdapter, fetcher: syntheticFetcher(body), writer, now: () => NOW });
    expect(summary).toMatchObject({ discovered: 2, inserted: 1, seen: 1 });
    expect(rows.size).toBe(1);
  });

  it.each([
    ["invalid XML", "<rdf:RDF>", "parse_failed"],
    ["a DOCTYPE", `<!DOCTYPE r>${rdf(item(TIMED))}`, "parse_failed"],
    ["too many items", rdf(item(TIMED).repeat(RSS_MAX_ITEMS + 1)), "parse_failed"],
    ["no items", rdf(""), "empty_result"],
  ])("writes nothing for %s", async (_label, body, failure) => {
    const { writer, submit } = memoryWriter();
    const summary = await runCollection({ adapter: qoo10PressAdapter, fetcher: syntheticFetcher(body), writer, now: () => NOW });
    expect(summary.failure).toBe(failure);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ["ambiguous dates", item(`${TIMED}、第2弾は2027年3月1日17:00～3月10日23:59`)],
    ["another publisher", item(TIMED, "https://prtimes.jp/main/html/rd/p/000009001.000099999.html")],
  ])("writes nothing for %s", async (_label, items) => {
    const { writer, submit } = memoryWriter();
    const summary = await runCollection({ adapter: qoo10PressAdapter, fetcher: syntheticFetcher(rdf(items)), writer, now: () => NOW });
    expect(summary).toMatchObject({ failure: null, discovered: 1, rejected: 1, inserted: 0 });
    expect(submit).not.toHaveBeenCalled();
  });

  it("ignores a feed of ordinary press releases without failing", async () => {
    const { writer, submit } = memoryWriter();
    const summary = await runCollection({
      adapter: qoo10PressAdapter,
      fetcher: syntheticFetcher(rdf(item("Qoo10、テスト用の新機能を提供開始") + item("Qoo10「メガ割」テスト開催レポート"))),
      writer,
      now: () => NOW,
    });
    expect(summary).toMatchObject({ failure: null, discovered: 2, ignored: 2, rejected: 0, inserted: 0 });
    expect(submit).not.toHaveBeenCalled();
  });
});

describe("synthetic fixture", () => {
  it("contains only invented test content", async () => {
    const body = await readFile(FIXTURE, "utf8");
    for (const { title } of parseRssItems(body)) expect(title).toContain("テスト");
    for (const [, link] of body.matchAll(/<link>([^<]*)<\/link>/g)) {
      expect(link === "https://prtimes.jp/" || /\/rd\/p\/00000900\d\.\d{9}\.html/.test(link)).toBe(true);
    }
  });
});

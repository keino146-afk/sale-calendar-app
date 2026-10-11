import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CandidateWriteInput, CandidateWriteOutcome, CandidateWriter, Fetcher, ParsedCandidate } from "../../contract";
import { runCollection } from "../../pipeline";
import { parseRssItems, RSS_MAX_BYTES, RSS_MAX_ITEMS, RssParseError } from "../../rss";
import { validateCandidate } from "../../validate";
import {
  AMAZON_NEWS_PARSER_VERSION,
  AMAZON_NEWS_SOURCE,
  amazonNewsAdapter,
  amazonNewsNormalizer,
  amazonNewsParser,
} from "./adapter";
import { extractSaleDateRange } from "./date-range";

// Everything here runs on synthetic data: no request leaves the process.

const NOW = new Date("2026-10-20T00:00:00Z");
const FIXTURE = new URL("./__fixtures__/amazon-news-synthetic.xml", import.meta.url);
const ARTICLE = "https://www.aboutamazon.jp/news/test-category/test-sale-2026";

const jst = (iso: string) => new Date(`${iso}+09:00`);

function feed(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>テスト</title>${items}</channel></rss>`;
}

function item(title: string, link = ARTICLE, description?: string): string {
  const desc = description === undefined ? "" : `<description>${description}</description>`;
  return `<item><title>${title}</title><link>${link}</link>${desc}</item>`;
}

const SALE_TITLE = "Amazon、テストセールを2026年11月6日9時から2026年11月9日23時59分まで開催";

function doc(body: string) {
  return { url: "https://feed.example.test/rss", status: 200, contentType: "application/rss+xml", body, fetchedAt: NOW };
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
  return amazonNewsNormalizer.normalize(parsed);
}

function validate(candidate: ParsedCandidate | null, now = NOW) {
  if (candidate === null) throw new Error("expected a candidate");
  return validateCandidate(candidate, { source: AMAZON_NEWS_SOURCE, checkedAt: now, now });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRssItems", () => {
  it("reads RSS 2.0 items as plain text", async () => {
    const items = parseRssItems(await readFile(FIXTURE, "utf8"));

    expect(items).toHaveLength(6);
    expect(items[0]).toEqual({
      title: "Amazon、テストセールを2026年11月6日（金）9時から2026年11月9日（月）23時59分まで開催",
      link: "https://www.aboutamazon.jp/news/test-category/test-sale-2026?utm_source=rss&utm_medium=feed#top",
      guid: "test-guid-0001",
      publishedAt: new Date("2026-10-19T01:00:00Z"),
      // CDATA markup stays inert text; it is never rendered or stored.
      description: "<p>テスト用の説明です。<b>これは架空の記事です。</b></p>",
    });
    expect(items[2]).toMatchObject({ description: null });
  });

  it("returns no items for an empty channel (the pipeline reports it)", () => {
    expect(parseRssItems(feed(""))).toEqual([]);
  });

  it.each([
    ["truncated XML", feed(item(SALE_TITLE)).slice(0, -20)],
    ["mismatched tags", feed("<item><title>x</link></item>")],
    ["two root elements", `${feed("")}<rss></rss>`],
    ["not RSS", "<feed><entry/></feed>"],
    ["no channel", "<rss version=\"2.0\"></rss>"],
    ["two channels", "<rss><channel></channel><channel></channel></rss>"],
    ["plain text", "not xml at all"],
    ["an unknown entity", feed(item("Amazon、セール&unknown;"))],
  ])("rejects %s", (_label, body) => {
    expect(() => parseRssItems(body)).toThrow(RssParseError);
  });

  it.each([
    ["DOCTYPE", `<?xml version="1.0"?><!DOCTYPE rss>${feed("").replace(/^<\?xml[^>]*>/, "")}`],
    ["internal ENTITY", `<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "テスト">]><rss><channel><item><title>&x;</title></item></channel></rss>`],
    ["external ENTITY", `<!DOCTYPE rss [<!ENTITY ext SYSTEM "file:///etc/passwd">]><rss><channel><item><title>&ext;</title></item></channel></rss>`],
    ["entity expansion", `<!DOCTYPE r [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;&a;">]><rss/>`],
    ["lower-case doctype", `<!doctype rss><rss/>`],
  ])("refuses %s declarations without expanding anything", (_label, body) => {
    expect(() => parseRssItems(body)).toThrow("DOCTYPE or ENTITY declarations are not accepted");
  });

  it("refuses oversized feeds instead of reading part of them", () => {
    const padding = `<!--${"x".repeat(RSS_MAX_BYTES)}-->`;
    expect(() => parseRssItems(feed(item(SALE_TITLE)) + padding)).toThrow("feed too large");
    // Counted in bytes: multi-byte text cannot slip past the limit.
    const wide = feed(item("あ".repeat(Math.ceil(RSS_MAX_BYTES / 3) + 1)));
    expect(wide.length).toBeLessThan(RSS_MAX_BYTES);
    expect(() => parseRssItems(wide)).toThrow("feed too large");
  });

  it("refuses feeds with too many items but accepts the limit", () => {
    expect(parseRssItems(feed(item(SALE_TITLE).repeat(RSS_MAX_ITEMS)))).toHaveLength(RSS_MAX_ITEMS);
    expect(() => parseRssItems(feed(item(SALE_TITLE).repeat(RSS_MAX_ITEMS + 1)))).toThrow("too many items");
  });

  it("treats a missing, blank or repeated field as absent", () => {
    const [missing, blank, repeated] = parseRssItems(
      feed("<item><link>a</link></item><item><title>  </title></item><item><title>a</title><title>b</title></item>"),
    );
    expect(missing.title).toBeNull();
    expect(blank.title).toBeNull();
    expect(repeated.title).toBeNull();
  });

  it("decodes the standard XML escapes only", () => {
    const [parsed] = parseRssItems(feed(item("A &amp; B &lt;テスト&gt;", `${ARTICLE}?a=1&amp;b=2`)));
    expect(parsed.title).toBe("A & B <テスト>");
    expect(parsed.link).toBe(`${ARTICLE}?a=1&b=2`);
  });
});

describe("extractSaleDateRange", () => {
  it("reads an explicit JST range and makes the inclusive end minute exclusive", () => {
    const result = extractSaleDateRange([SALE_TITLE]);
    expect(result).toEqual({
      ok: true,
      range: {
        startsAt: jst("2026-11-06T09:00:00"),
        // 23時59分まで -> 2026-11-10 00:00 JST, exclusive.
        endsAt: jst("2026-11-10T00:00:00"),
        text: "2026年11月6日9時から2026年11月9日23時59分まで",
      },
    });
    if (result.ok) expect(result.range.endsAt.toISOString()).toBe("2026-11-09T15:00:00.000Z");
  });

  it("accepts weekdays, full-width digits and explicit start minutes", () => {
    const result = extractSaleDateRange(["テストセール ２０２６年１１月６日（金）９時３０分から２０２６年１１月９日（月・祝）２３時５９分まで"]);
    expect(result).toMatchObject({ ok: true, range: { startsAt: jst("2026-11-06T09:30:00"), endsAt: jst("2026-11-10T00:00:00") } });
  });

  it("gives the same instants whatever the system time zone is", () => {
    const original = process.env.TZ;
    try {
      const results = ["UTC", "America/Los_Angeles", "Asia/Tokyo", "Pacific/Kiritimati"].map((zone) => {
        process.env.TZ = zone;
        const result = extractSaleDateRange([SALE_TITLE]);
        return result.ok ? [result.range.startsAt.toISOString(), result.range.endsAt.toISOString()] : null;
      });
      expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
      expect(results[0]).toEqual(["2026-11-06T00:00:00.000Z", "2026-11-09T15:00:00.000Z"]);
    } finally {
      if (original === undefined) delete process.env.TZ;
      else process.env.TZ = original;
    }
  });

  it.each([
    ["start year missing", "テストセールを11月6日9時から2026年11月9日23時59分まで"],
    ["end year missing", "テストセールを2026年11月6日9時から11月9日23時59分まで"],
    ["both years missing", "テストセールを11月6日9時から11月9日23時59分まで"],
    ["times missing", "テストセールを2026年11月6日から2026年11月9日まで"],
    ["start time missing", "テストセールを2026年11月6日から2026年11月9日23時59分まで"],
    ["end minutes missing", "テストセールを2026年11月6日9時から2026年11月9日23時まで"],
    ["no まで", "テストセールを2026年11月6日9時から2026年11月9日23時59分"],
    ["近日", "テストセールを近日開催"],
    ["今週末", "テストセールを今週末に開催"],
    ["来月", "テストセールを来月開催"],
    ["3日間", "テストセールを3日間開催"],
  ])("finds no period when the %s", (_label, text) => {
    expect(extractSaleDateRange([text])).toEqual({ ok: false, reason: "no_date_range" });
  });

  it.each([
    ["two different ranges in one text", `${SALE_TITLE}、追加で2026年11月20日9時から2026年11月21日23時59分まで`],
    ["a stray date next to a range", `${SALE_TITLE}（先行は11月1日から）`],
  ])("rejects %s as ambiguous", (_label, text) => {
    expect(extractSaleDateRange([text])).toEqual({ ok: false, reason: "ambiguous_date_range" });
  });

  it("rejects title and description that state different ranges", () => {
    expect(
      extractSaleDateRange([SALE_TITLE, "期間は2026年11月7日9時から2026年11月9日23時59分までです"]),
    ).toEqual({ ok: false, reason: "ambiguous_date_range" });
  });

  it("accepts the same range stated in title and description", () => {
    expect(extractSaleDateRange([SALE_TITLE, "期間は2026年11月6日9時から2026年11月9日23時59分までです"])).toMatchObject({
      ok: true,
    });
  });

  it.each([
    ["February 30", "テストセールを2027年2月30日9時から2027年3月2日23時59分まで"],
    ["hour 24", "テストセールを2026年11月6日24時から2026年11月9日23時59分まで"],
    ["minute 60", "テストセールを2026年11月6日9時から2026年11月9日23時60分まで"],
    ["month 13", "テストセールを2026年13月6日9時から2026年13月9日23時59分まで"],
  ])("rejects an impossible date (%s)", (_label, text) => {
    expect(extractSaleDateRange([text])).toEqual({ ok: false, reason: "invalid_date" });
  });
});

describe("amazonNewsNormalizer", () => {
  it("builds a candidate with the canonical article URL as identity", () => {
    const candidate = normalizeOne(SALE_TITLE, `${ARTICLE}?utm_source=rss&utm_medium=feed#top`, "<p>説明</p>");
    expect(candidate).toEqual({
      externalKey: ARTICLE,
      sourceUrl: ARTICLE,
      title: SALE_TITLE,
      description: null,
      startsAt: jst("2026-11-06T09:00:00"),
      endsAt: jst("2026-11-10T00:00:00"),
      isDateOnly: false,
      evidenceExcerpt: SALE_TITLE,
    });
  });

  it("adds the period wording to the evidence when it came from the description", () => {
    const candidate = normalizeOne("Amazon、テストセールを開催", ARTICLE, "<p>期間は2026年11月6日9時から2026年11月9日23時59分まで</p>");
    expect(candidate?.evidenceExcerpt).toBe("Amazon、テストセールを開催\n2026年11月6日9時から2026年11月9日23時59分まで");
    expect(candidate?.evidenceExcerpt).not.toContain("<p>");
  });

  it.each(["Amazon、テスト用の新しいサービスを開始", "Amazon、テスト用の配送拠点を開設", ""])(
    "ignores news that is not a sale (%j)",
    (title) => {
      expect(normalizeOne(title)).toBeNull();
    },
  );

  it.each(["Amazon、テストセールを開催", "テスト・プライムデー開催", "テスト・ブラックフライデー開催", "Amazon、テストタイムセール"])(
    "treats %j as a sale announcement",
    (title) => {
      expect(normalizeOne(title)).not.toBeNull();
    },
  );

  it("keeps the period empty when it cannot be read, so the validator rejects it", () => {
    const candidate = normalizeOne("Amazon、テストセールを11月6日9時から11月9日23時59分まで開催");
    expect(candidate).toMatchObject({ startsAt: null, endsAt: null, isDateOnly: null });
    expect(validate(candidate)).toEqual({ ok: false, issues: ["missing_period"] });
  });
});

describe("validated Amazon candidates", () => {
  it("passes a complete candidate with the Amazon parser version and a content hash", () => {
    const result = validate(normalizeOne(SALE_TITLE));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({
      parserVersion: AMAZON_NEWS_PARSER_VERSION,
      sourceCheckedAt: NOW,
      isDateOnly: false,
      description: null,
    });
    expect(result.value.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps the content hash stable and changes it when the content changes", () => {
    const hash = (title: string) => {
      const result = validate(normalizeOne(title));
      return result.ok ? result.value.contentHash : null;
    };
    expect(hash(SALE_TITLE)).toBe(hash(SALE_TITLE));
    expect(hash(SALE_TITLE.replace("9日23時59分", "10日23時59分"))).not.toBe(hash(SALE_TITLE));
    expect(hash(SALE_TITLE.replace("テストセール", "テスト大セール"))).not.toBe(hash(SALE_TITLE));
  });

  it.each([
    ["start after end", "テストセールを2026年11月9日9時から2026年11月6日23時59分まで", "period_order"],
    ["start equal to end", "テストセールを2026年11月6日9時から2026年11月6日8時59分まで", "period_order"],
    ["longer than 31 days", "テストセールを2026年11月1日0時から2026年12月5日23時59分まで", "period_too_long"],
    ["more than 400 days ahead", "テストセールを2028年11月6日9時から2028年11月9日23時59分まで", "period_too_far"],
    ["already ended", "テストセールを2026年10月1日9時から2026年10月3日23時59分まで", "already_ended"],
  ])("rejects a period %s", (_label, title, issue) => {
    const result = validate(normalizeOne(title));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain(issue);
  });

  it.each([
    ["http", "http://www.aboutamazon.jp/news/test-category/test-sale-2026"],
    ["another host", "https://evil-aboutamazon.jp/news/test-category/test-sale-2026"],
    ["a lookalike suffix", "https://www.aboutamazon.jp.evil.example/news/test-category/test-sale-2026"],
    ["credentials", "https://user@www.aboutamazon.jp/news/test-category/test-sale-2026"],
    ["a port", "https://www.aboutamazon.jp:8443/news/test-category/test-sale-2026"],
    ["a non-tracking query", `${ARTICLE}?page=2`],
    ["a path outside news articles", "https://www.aboutamazon.jp/rss/feed.rss"],
    ["a trailing slash", `${ARTICLE}/`],
    ["a malformed URL", "not a url"],
    ["no link", ""],
  ])("rejects a link with %s", (_label, link) => {
    const result = validate(normalizeOne(SALE_TITLE, link));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain("source_url");
  });

  it("mirrors the database source pattern", async () => {
    const migration = await readFile("supabase/migrations/20261011110237_manual_source_policy.sql", "utf8");
    expect(migration).toContain(`'${AMAZON_NEWS_SOURCE.sourceUrlPattern.source.replaceAll("\\/", "/")}'`);
    expect(migration).toContain(`'${AMAZON_NEWS_SOURCE.sourceId}'`);
    expect(migration).toContain(`'${AMAZON_NEWS_SOURCE.expectedHost}'`);
  });
});

// In-memory writer with the database RPC's identity and hash rules.
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
  const writer: CandidateWriter = { submit };
  return { writer, rows, submit };
}

function syntheticFetcher(body: string): Fetcher & { fetch: ReturnType<typeof vi.fn> } {
  return { fetch: vi.fn(async (url: string) => ({ ...doc(body), url })) };
}

describe("Amazon news pipeline (synthetic end to end)", () => {
  it("submits only complete sale candidates, without any network access", async () => {
    const networkFetch = vi.spyOn(globalThis, "fetch");
    const { writer, rows } = memoryWriter();
    const fetcher = syntheticFetcher(await readFile(FIXTURE, "utf8"));

    const summary = await runCollection({ adapter: amazonNewsAdapter, fetcher, writer, now: () => NOW });

    expect(networkFetch).not.toHaveBeenCalled();
    expect(fetcher.fetch).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({
      sourceId: "amazon-aboutamazon-news",
      parserVersion: "amazon-news-rss-v1",
      failure: null,
      discovered: 6,
      ignored: 1,
      inserted: 2,
      rejected: 3,
      writeErrors: 0,
      rejectedIssues: { missing_period: 3 },
    });
    expect([...rows.values()].map(({ input }) => input)).toEqual([
      expect.objectContaining({
        sourceId: "amazon-aboutamazon-news",
        externalKey: ARTICLE,
        sourceUrl: ARTICLE,
        startsAt: jst("2026-11-06T09:00:00"),
        endsAt: jst("2026-11-10T00:00:00"),
        isDateOnly: false,
        description: null,
        sourceCheckedAt: NOW,
        parserVersion: "amazon-news-rss-v1",
      }),
      expect.objectContaining({
        externalKey: "https://www.aboutamazon.jp/news/test-category/test-black-friday-2026",
        startsAt: jst("2026-11-20T00:00:00"),
        endsAt: jst("2026-11-28T00:00:00"),
        evidenceExcerpt: "Amazon、ブラックフライデーのテスト企画を開催\n2026年11月20日0時から2026年11月27日23時59分まで",
      }),
    ]);
    for (const { input } of rows.values()) {
      expect(Object.keys(input)).not.toContain("status");
      expect(JSON.stringify(input)).not.toMatch(/<[a-z]/i);
    }
  });

  it("treats the same canonical link as one candidate", async () => {
    const { writer, rows } = memoryWriter();
    const body = feed(item(SALE_TITLE, `${ARTICLE}?utm_source=rss`) + item(SALE_TITLE, `${ARTICLE}#top`));

    const summary = await runCollection({ adapter: amazonNewsAdapter, fetcher: syntheticFetcher(body), writer, now: () => NOW });

    expect(summary).toMatchObject({ discovered: 2, inserted: 1, seen: 1 });
    expect(rows.size).toBe(1);
  });

  it.each([
    ["invalid XML", "<rss><channel><item>", "parse_failed"],
    ["a DOCTYPE", `<!DOCTYPE rss>${feed(item(SALE_TITLE))}`, "parse_failed"],
    ["too many items", feed(item(SALE_TITLE).repeat(RSS_MAX_ITEMS + 1)), "parse_failed"],
    ["an empty channel", feed(""), "empty_result"],
  ])("writes nothing for %s", async (_label, body, failure) => {
    const { writer, submit } = memoryWriter();
    const summary = await runCollection({ adapter: amazonNewsAdapter, fetcher: syntheticFetcher(body), writer, now: () => NOW });
    expect(summary.failure).toBe(failure);
    expect(submit).not.toHaveBeenCalled();
  });

  it.each([
    ["ambiguous dates", item(`${SALE_TITLE}、追加で2026年11月20日9時から2026年11月21日23時59分まで`)],
    ["an invalid URL", item(SALE_TITLE, "http://www.aboutamazon.jp/news/test-category/test-sale-2026")],
  ])("writes nothing for %s", async (_label, items) => {
    const { writer, submit } = memoryWriter();
    const summary = await runCollection({
      adapter: amazonNewsAdapter,
      fetcher: syntheticFetcher(feed(items)),
      writer,
      now: () => NOW,
    });
    expect(summary).toMatchObject({ failure: null, discovered: 1, rejected: 1, inserted: 0 });
    expect(submit).not.toHaveBeenCalled();
  });

  it("ignores a feed of ordinary news without failing", async () => {
    const { writer, submit } = memoryWriter();
    const summary = await runCollection({
      adapter: amazonNewsAdapter,
      fetcher: syntheticFetcher(feed(item("Amazon、テスト用の新しいサービスを開始"))),
      writer,
      now: () => NOW,
    });
    expect(summary).toMatchObject({ failure: null, discovered: 1, ignored: 1, rejected: 0, inserted: 0 });
    expect(submit).not.toHaveBeenCalled();
  });

  it("parses through the adapter's parser exactly as the generic reader does", async () => {
    const body = await readFile(FIXTURE, "utf8");
    expect(amazonNewsParser.parse(doc(body)).map((c) => c.title)).toEqual(parseRssItems(body).map((i) => i.title));
  });
});

describe("synthetic fixture", () => {
  it("contains only invented test content", async () => {
    const body = await readFile(FIXTURE, "utf8");
    for (const title of parseRssItems(body).map((i) => i.title)) expect(title).toContain("テスト");
    for (const link of [...body.matchAll(/<link>([^<]*)<\/link>/g)].map(([, l]) => l)) {
      expect(link === "https://www.aboutamazon.jp/news" || link.includes("/news/test-category/test-")).toBe(true);
    }
  });
});

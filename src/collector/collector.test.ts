import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type {
  CandidateWriteInput,
  CandidateWriteOutcome,
  CandidateWriter,
  FetchedDocument,
  Fetcher,
  ParsedCandidate,
  Parser,
  SourceAdapter,
  SourceDescriptor,
} from "./contract";
import { computeContentHash } from "./content-hash";
import { runCollection } from "./pipeline";
import { withRetry } from "./retry";
import { canonicalizeSourceUrl } from "./url";
import { MAX_SALE_DURATION_DAYS, validateCandidate } from "./validate";

const NOW = new Date("2026-10-20T00:00:00Z");

const SOURCE: SourceDescriptor = {
  sourceId: "synthetic-news",
  retailerSlug: "amazon",
  expectedHost: "news.example.test",
  sourceUrlPattern: /^https:\/\/news\.example\.test\/news\/[a-z0-9-]+$/,
  parserVersion: "synthetic-1",
};

function candidate(overrides: Partial<ParsedCandidate> = {}): ParsedCandidate {
  return {
    externalKey: "https://news.example.test/news/autumn-sale",
    sourceUrl: "https://news.example.test/news/autumn-sale",
    title: "  秋の大感謝セール  ",
    description: null,
    startsAt: new Date("2026-11-05T15:00:00Z"), // 11/6 00:00 JST
    endsAt: new Date("2026-11-09T14:59:00Z"), // 11/9 23:59 JST
    isDateOnly: false,
    evidenceExcerpt: "秋の大感謝セールを11月6日0時から11月9日23時59分まで開催",
    ...overrides,
  };
}

const context = { source: SOURCE, checkedAt: NOW, now: NOW };

describe("validateCandidate", () => {
  it("accepts a complete candidate, trims the title and hashes the content", () => {
    const result = validateCandidate(candidate(), context);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.title).toBe("秋の大感謝セール");
    expect(result.value.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.value.parserVersion).toBe("synthetic-1");
    expect(result.value.sourceCheckedAt).toBe(NOW);
    expect(Object.keys(result.value)).not.toContain("status");
  });

  it.each([
    ["missing start", { startsAt: null }, "missing_period"],
    ["missing end", { endsAt: null }, "missing_period"],
    ["unknown date-only flag", { isDateOnly: null }, "missing_period"],
    ["invalid date", { startsAt: new Date("nope") }, "missing_period"],
    ["end before start", { endsAt: new Date("2026-11-01T00:00:00Z") }, "period_order"],
    ["end equal to start", { endsAt: new Date("2026-11-05T15:00:00Z") }, "period_order"],
    ["too long", { endsAt: new Date("2026-12-31T15:00:00Z") }, "period_too_long"],
    ["too far ahead", { startsAt: new Date("2028-01-01T00:00:00Z"), endsAt: new Date("2028-01-05T00:00:00Z") }, "period_too_far"],
    ["already ended", { startsAt: new Date("2026-10-01T00:00:00Z"), endsAt: new Date("2026-10-05T00:00:00Z") }, "already_ended"],
    ["date-only not at JST midnight", { isDateOnly: true }, "date_only_not_midnight"],
    ["blank title", { title: " 　 " }, "title"],
    ["overlong title", { title: "あ".repeat(201) }, "title"],
    ["overlong description", { description: "あ".repeat(5001) }, "description"],
    ["empty evidence", { evidenceExcerpt: "" }, "evidence"],
    ["overlong evidence", { evidenceExcerpt: "x".repeat(2001) }, "evidence"],
    ["http URL", { sourceUrl: "http://news.example.test/news/autumn-sale" }, "source_url"],
    ["wrong host", { sourceUrl: "https://evil.example/news/autumn-sale" }, "source_url"],
    ["look-alike host", { sourceUrl: "https://news.example.test.evil.example/news/autumn-sale" }, "source_url"],
    ["credentials", { sourceUrl: "https://user@news.example.test/news/autumn-sale" }, "source_url"],
    ["port", { sourceUrl: "https://news.example.test:8443/news/autumn-sale" }, "source_url"],
    ["outside the source pattern", { sourceUrl: "https://news.example.test/other/autumn-sale" }, "source_url"],
    ["blank external key", { externalKey: "" }, "external_key"],
    ["external key with spaces", { externalKey: "a b" }, "external_key"],
  ])("rejects %s", (_label, overrides, issue) => {
    const result = validateCandidate(candidate(overrides as Partial<ParsedCandidate>), context);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toContain(issue);
  });

  it("accepts a date-only candidate at JST midnights", () => {
    const result = validateCandidate(
      candidate({
        isDateOnly: true,
        startsAt: new Date("2026-11-05T15:00:00Z"),
        endsAt: new Date("2026-11-09T15:00:00Z"),
      }),
      context,
    );
    expect(result.ok).toBe(true);
  });

  it(`allows up to ${MAX_SALE_DURATION_DAYS} days`, () => {
    const start = new Date("2026-11-05T15:00:00Z");
    const end = new Date(start.getTime() + MAX_SALE_DURATION_DAYS * 24 * 60 * 60 * 1000);
    expect(validateCandidate(candidate({ startsAt: start, endsAt: end }), context).ok).toBe(true);
  });

  it("rejects a checked time in the future and a bad parser version", () => {
    const future = validateCandidate(candidate(), { ...context, checkedAt: new Date("2026-10-20T01:00:00Z") });
    expect(future.ok === false && future.issues).toContain("checked_at");

    const badVersion = validateCandidate(candidate(), {
      ...context,
      source: { ...SOURCE, parserVersion: "bad version!" },
    });
    expect(badVersion.ok === false && badVersion.issues).toContain("parser_version");
  });
});

describe("computeContentHash", () => {
  const base = {
    sourceUrl: "https://news.example.test/news/autumn-sale",
    title: "秋の大感謝セール",
    description: null,
    startsAt: new Date("2026-11-05T15:00:00Z"),
    endsAt: new Date("2026-11-09T14:59:00Z"),
    isDateOnly: false,
  };

  it("is stable and changes when any reviewed field changes", () => {
    expect(computeContentHash(base)).toBe(computeContentHash({ ...base }));
    expect(computeContentHash(base)).toMatch(/^[0-9a-f]{64}$/);
    for (const change of [
      { title: "秋の大感謝セール（延長）" },
      { endsAt: new Date("2026-11-10T14:59:00Z") },
      { description: "説明" },
      { isDateOnly: true },
      { sourceUrl: "https://news.example.test/news/autumn-sale-2" },
    ]) {
      expect(computeContentHash({ ...base, ...change })).not.toBe(computeContentHash(base));
    }
  });
});

describe("canonicalizeSourceUrl", () => {
  it("drops tracking parameters and fragments and lower-cases the host", () => {
    expect(canonicalizeSourceUrl("https://News.Example.Test/news/a?utm_source=rss&utm_medium=feed#top")).toBe(
      "https://news.example.test/news/a",
    );
    expect(canonicalizeSourceUrl("https://news.example.test/news/a?b=2&fbclid=x&a=1")).toBe(
      "https://news.example.test/news/a?a=1&b=2",
    );
  });

  it.each(["http://news.example.test/a", "https://u:p@news.example.test/a", "https://news.example.test:8443/a", "not a url"])(
    "rejects %s",
    (raw) => {
      expect(canonicalizeSourceUrl(raw)).toBeNull();
    },
  );
});

describe("withRetry", () => {
  const ok: FetchedDocument = { url: "u", status: 200, contentType: "application/xml", body: "", fetchedAt: NOW };

  it("retries network errors and 5xx with exponential backoff, not 4xx", async () => {
    const sleep = vi.fn<(ms: number) => Promise<void>>(async () => {});
    const flaky: Fetcher = {
      fetch: vi
        .fn()
        .mockRejectedValueOnce(new Error("ECONNRESET"))
        .mockResolvedValueOnce({ ...ok, status: 503 })
        .mockResolvedValueOnce(ok),
    };
    expect(await withRetry(flaky, { attempts: 3, baseDelayMs: 100, sleep }).fetch("u")).toBe(ok);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([100, 200]);

    const refused: Fetcher = { fetch: vi.fn().mockResolvedValue({ ...ok, status: 403 }) };
    expect((await withRetry(refused, { attempts: 3, baseDelayMs: 100, sleep }).fetch("u")).status).toBe(403);
    expect(refused.fetch).toHaveBeenCalledTimes(1);
  });

  it("gives up after the configured attempts", async () => {
    const down: Fetcher = { fetch: vi.fn().mockRejectedValue(new Error("down")) };
    await expect(withRetry(down, { attempts: 2, baseDelayMs: 1, sleep: async () => {} }).fetch("u")).rejects.toThrow(
      "down",
    );
    expect(down.fetch).toHaveBeenCalledTimes(2);
  });
});

// Test-only parser for the synthetic fixture: reads "<M>月<D>日<H>時から<M>月<D>日<H>時<m>分まで"
// from titles; items without a stated period keep null dates.
const syntheticParser: Parser = {
  parse(document) {
    const items = [...document.body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(([, item]) => item);
    return items.map((item) => {
      const title = /<title>([\s\S]*?)<\/title>/.exec(item)?.[1] ?? "";
      const link = (/<link>([\s\S]*?)<\/link>/.exec(item)?.[1] ?? "").replaceAll("&amp;", "&");
      const period = /(\d+)月(\d+)日(\d+)時から(\d+)月(\d+)日(\d+)時(\d+)分まで/.exec(title);
      const jst = (m: string, d: string, h: string, min = "0") =>
        new Date(Date.UTC(2026, Number(m) - 1, Number(d), Number(h), Number(min)) - 9 * 60 * 60 * 1000);
      return {
        externalKey: link,
        sourceUrl: link,
        title: title.replace(/^テストストア、/, "").replace(/を.*$/, ""),
        description: null,
        startsAt: period ? jst(period[1], period[2], period[3]) : null,
        endsAt: period ? jst(period[4], period[5], period[6], period[7]) : null,
        isDateOnly: period ? false : null,
        evidenceExcerpt: title,
      };
    });
  },
};

const normalizer = {
  normalize(item: ParsedCandidate): ParsedCandidate {
    const url = canonicalizeSourceUrl(item.sourceUrl) ?? item.sourceUrl;
    return { ...item, sourceUrl: url, externalKey: url };
  },
};

const ADAPTER: SourceAdapter = {
  source: SOURCE,
  documentUrl: "https://news.example.test/rss",
  parser: syntheticParser,
  normalizer,
};

// In-memory writer with the same identity/hash rules as the database RPC.
function memoryWriter() {
  const rows = new Map<string, { firstHash: string; lastHash: string; changed: boolean; input: CandidateWriteInput }>();
  const writer: CandidateWriter = {
    async submit(input): Promise<CandidateWriteOutcome> {
      const key = `${input.sourceId}|${input.externalKey}`;
      const existing = rows.get(key);
      if (!existing) {
        rows.set(key, { firstHash: input.contentHash, lastHash: input.contentHash, changed: false, input });
        return "inserted";
      }
      existing.lastHash = input.contentHash;
      existing.changed ||= input.contentHash !== existing.firstHash;
      return input.contentHash === existing.firstHash ? "seen" : "changed";
    },
  };
  return { writer, rows };
}

async function fixtureFetcher(body?: string): Promise<Fetcher> {
  const xml = body ?? (await readFile(new URL("./__fixtures__/synthetic-feed.xml", import.meta.url), "utf8"));
  return {
    fetch: async (url) => ({ url, status: 200, contentType: "application/rss+xml", body: xml, fetchedAt: NOW }),
  };
}

describe("runCollection", () => {
  it("submits only complete candidates and never guesses missing dates", async () => {
    const { writer, rows } = memoryWriter();

    const summary = await runCollection({ adapter: ADAPTER, fetcher: await fixtureFetcher(), writer, now: () => NOW });

    expect(summary).toMatchObject({
      sourceId: "synthetic-news",
      httpStatus: 200,
      failure: null,
      discovered: 3,
      inserted: 1,
      rejected: 2,
      writeErrors: 0,
    });
    expect(summary.rejectedIssues.missing_period).toBe(2);
    const [row] = [...rows.values()];
    expect(row.input).toMatchObject({
      sourceId: "synthetic-news",
      externalKey: "https://news.example.test/news/autumn-sale",
      sourceUrl: "https://news.example.test/news/autumn-sale",
      title: "秋の大感謝セール",
      startsAt: new Date("2026-11-05T15:00:00Z"),
      endsAt: new Date("2026-11-09T14:59:00Z"),
      isDateOnly: false,
    });
    expect(Object.keys(row.input)).not.toContain("status");
  });

  it("is idempotent across runs and flags changed content", async () => {
    const { writer, rows } = memoryWriter();
    const fetcher = await fixtureFetcher();

    await runCollection({ adapter: ADAPTER, fetcher, writer, now: () => NOW });
    const second = await runCollection({ adapter: ADAPTER, fetcher, writer, now: () => NOW });
    expect(second).toMatchObject({ inserted: 0, seen: 1, changed: 0 });
    expect(rows.size).toBe(1);

    const xml = (await readFile(new URL("./__fixtures__/synthetic-feed.xml", import.meta.url), "utf8")).replace(
      "11月9日23時59分",
      "11月10日23時59分",
    );
    const third = await runCollection({ adapter: ADAPTER, fetcher: await fixtureFetcher(xml), writer, now: () => NOW });
    expect(third).toMatchObject({ inserted: 0, seen: 0, changed: 1 });
    expect(rows.size).toBe(1);
    expect([...rows.values()][0].changed).toBe(true);
  });

  it.each([
    ["fetch errors", { fetch: async () => Promise.reject(new Error("ECONNRESET")) }, "fetch_failed", null],
    [
      "HTTP errors",
      { fetch: async (url: string) => ({ url, status: 403, contentType: null, body: "", fetchedAt: NOW }) },
      "http_error",
      403,
    ],
    [
      "empty documents",
      { fetch: async (url: string) => ({ url, status: 200, contentType: "text/xml", body: "<rss></rss>", fetchedAt: NOW }) },
      "empty_result",
      200,
    ],
  ] as const)("reports %s without writing anything", async (_label, fetcher, failure, status) => {
    const submit = vi.fn();

    const summary = await runCollection({ adapter: ADAPTER, fetcher, writer: { submit }, now: () => NOW });

    expect(summary.failure).toBe(failure);
    expect(summary.httpStatus).toBe(status);
    expect(submit).not.toHaveBeenCalled();
  });

  it("reports parser exceptions as parse failures", async () => {
    const submit = vi.fn();
    const broken: SourceAdapter = {
      ...ADAPTER,
      parser: {
        parse() {
          throw new Error("markup changed");
        },
      },
    };

    const summary = await runCollection({ adapter: broken, fetcher: await fixtureFetcher(), writer: { submit }, now: () => NOW });

    expect(summary.failure).toBe("parse_failed");
    expect(submit).not.toHaveBeenCalled();
  });

  it("keeps going when one write fails", async () => {
    const submit = vi.fn().mockRejectedValue(new Error("rpc failed"));

    const summary = await runCollection({ adapter: ADAPTER, fetcher: await fixtureFetcher(), writer: { submit }, now: () => NOW });

    expect(summary).toMatchObject({ failure: null, writeErrors: 1, inserted: 0 });
  });
});

describe("collector boundaries", () => {
  async function files(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    return (
      await Promise.all(
        entries.map((entry) => {
          const path = join(dir, entry.name);
          return entry.isDirectory() ? files(path) : Promise.resolve([path]);
        }),
      )
    ).flat();
  }

  it("has no network access, Supabase client or sale lifecycle status", async () => {
    const sources = (await files("src/collector")).filter((file) => /\.ts$/.test(file) && !file.endsWith(".test.ts"));
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const code = await readFile(file, "utf8");
      expect(code).not.toMatch(/node:https?|undici|globalThis\.fetch|await fetch\(|@supabase\//);
      expect(code).not.toMatch(/"(published|pending_review|archived|rejected)"/);
      expect(code).not.toMatch(/sale_events/);
    }
  });

  it("is not imported by the web app", async () => {
    for (const file of (await files("src/app")).filter((f) => /\.tsx?$/.test(f))) {
      expect(await readFile(file, "utf8")).not.toMatch(/@\/collector|\/collector\//);
    }
  });
});

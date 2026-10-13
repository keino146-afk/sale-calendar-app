import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as adapterModule from "./adapter";
import { QOO10_PRESS_LIVE_COLLECTION_STATUS } from "./adapter";

// Fail-closed guard for the Qoo10 / PR TIMES live-source decision (see the
// comment on QOO10_PRESS_LIVE_COLLECTION_STATUS). The collector boundary test
// already forbids network code inside src/collector; these checks cover the
// ways a live run could be wired up from elsewhere. Changing any of them
// requires the documented permission first, not just a code change.

const QOO10_DIR = "src/collector/sources/qoo10-press/";
const MANUAL_SOURCE_MIGRATION = "supabase/migrations/20261012132058_qoo10_prtimes_manual_source.sql";

async function files(dir: string, pattern: RegExp): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return entry.name === "node_modules" ? [] : files(path, pattern);
      return pattern.test(entry.name) ? [path] : [];
    }),
  );
  return nested.flat();
}

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const isTest = (file: string) => /\.test\.(ts|tsx)$/.test(file) || file.startsWith("src/test/");

async function codeFiles(): Promise<string[]> {
  const roots = await Promise.all(["src", "scripts", "supabase/functions"].map((dir) => files(dir, CODE)));
  const configs = (await readdir(".")).filter((name) => CODE.test(name));
  return [...roots.flat(), ...configs];
}

async function matching(paths: string[], pattern: RegExp): Promise<string[]> {
  const hits: string[] = [];
  for (const path of paths) {
    if (pattern.test(await readFile(path, "utf8"))) hits.push(path);
  }
  return hits;
}

describe("Qoo10 / PR TIMES live-source gate", () => {
  it("records live collection as blocked pending permission", () => {
    expect(QOO10_PRESS_LIVE_COLLECTION_STATUS).toBe("blocked_pending_permission");
  });

  it("ships no real fetcher with the Qoo10 adapter", () => {
    for (const value of Object.values(adapterModule)) {
      const fetchMember = typeof value === "object" && value !== null ? (value as { fetch?: unknown }).fetch : undefined;
      expect(typeof fetchMember).not.toBe("function");
    }
    expect(Object.keys(adapterModule).filter((name) => /fetcher/i.test(name))).toEqual([]);
  });

  it("is not wired into any runner outside its own directory", async () => {
    const outside = (await codeFiles()).filter((file) => !file.startsWith(QOO10_DIR));
    expect(await matching(outside, /sources\/qoo10-press|qoo10PressAdapter|QOO10_PRESS_FEED_URL/)).toEqual([]);
  });

  it("names a PR TIMES feed only in the offline adapter", async () => {
    const runtime = (await codeFiles()).filter((file) => !isTest(file));
    expect(await matching(runtime, /prtimes\.jp\/(companyrdf|index\.rdf|rss)|companyrdf\.php/)).toEqual([
      `${QOO10_DIR}adapter.ts`,
    ]);
  });

  it("uses no Qoo10 page URL as a collector source", async () => {
    const collector = (await files("src/collector", CODE)).filter((file) => !isTest(file));
    expect(collector.length).toBeGreaterThan(0);
    expect(await matching(collector, /["'`]https?:\/\/(?:[a-z0-9-]+\.)*qoo10\.jp/i)).toEqual([]);
  });

  it("has no scheduled or collector workflow and no cron", async () => {
    const workflows = await files(".github/workflows", /\.ya?ml$/);
    expect(workflows.length).toBeGreaterThan(0);
    expect(await matching(workflows, /^\s*schedule\s*:|collector|prtimes|qoo10|runCollection/im)).toEqual([]);
    expect(await matching(await files(".", /^vercel\.json$/), /crons/)).toEqual([]);
  });

  it("never adds a PR TIMES / Qoo10 collection source or a collector in migrations", async () => {
    const migrations = await files("supabase/migrations", /\.sql$/);
    expect(migrations.length).toBeGreaterThan(0);
    // The only PR TIMES source is the manual-only policy row (Phase 6B).
    expect(await matching(migrations, /prtimes|qoo10-ebay-japan-press/i)).toEqual([MANUAL_SOURCE_MIGRATION]);
    expect(await matching(migrations, /enabled\s*=\s*true|set\s+enabled|insert\s+into\s+private\.collector_users/i)).toEqual([]);
  });

  it("allows PR TIMES only as a disabled, manual-only eBay Japan article source", async () => {
    // The whole migration, comments and whitespace aside, must be exactly this
    // one policy row plus its existence check: nothing enabled, no collector,
    // no feed URL, no other statement.
    const sql = (await readFile(MANUAL_SOURCE_MIGRATION, "utf8")).replace(/--.*$/gm, "").replace(/\s+/g, " ").trim();
    expect(sql).toBe(
      [
        "insert into private.collection_sources ( id, retailer_id, expected_host, source_url_pattern, enabled, allow_manual_source )",
        "select 'qoo10-ebay-japan-press', r.id, 'prtimes.jp', '^https://prtimes\\.jp/main/html/rd/p/[0-9]{9}\\.000022933\\.html$', false, true",
        "from public.retailers r where r.slug = 'qoo10';",
        "do $$ begin if (select count(*) from private.collection_sources where id = 'qoo10-ebay-japan-press') <> 1 then",
        "raise exception 'qoo10 retailer not found'; end if; end; $$;",
      ].join(" "),
    );
  });
});

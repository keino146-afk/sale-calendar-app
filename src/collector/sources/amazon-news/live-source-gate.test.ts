import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as adapterModule from "./adapter";
import { AMAZON_NEWS_LIVE_COLLECTION_STATUS } from "./adapter";

// Fail-closed guard for the Amazon live-source decision (see the comment on
// AMAZON_NEWS_LIVE_COLLECTION_STATUS). The collector boundary test already
// forbids network code inside src/collector; these checks cover the ways a
// live run could be wired up from elsewhere. Changing any of them requires
// the documented permission first, not just a code change.

const AMAZON_DIR = "src/collector/sources/amazon-news/";

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

describe("Amazon live-source gate", () => {
  it("records live collection as blocked pending permission", () => {
    expect(AMAZON_NEWS_LIVE_COLLECTION_STATUS).toBe("blocked_pending_permission");
  });

  it("ships no real fetcher with the Amazon adapter", () => {
    for (const value of Object.values(adapterModule)) {
      const fetchMember = typeof value === "object" && value !== null ? (value as { fetch?: unknown }).fetch : undefined;
      expect(typeof fetchMember).not.toBe("function");
    }
    expect(Object.keys(adapterModule).filter((name) => /fetcher/i.test(name))).toEqual([]);
  });

  it("is not wired into any runner outside its own directory", async () => {
    const outside = (await codeFiles()).filter((file) => !file.startsWith(AMAZON_DIR));
    expect(await matching(outside, /sources\/amazon-news|amazonNewsAdapter|AMAZON_NEWS_FEED_URL/)).toEqual([]);
  });

  it("names the feed URL only in the offline adapter", async () => {
    const runtime = (await codeFiles()).filter((file) => !isTest(file));
    expect(await matching(runtime, /aboutamazon\.jp\/rss|aboutamazon\.jp\/feed/)).toEqual([`${AMAZON_DIR}adapter.ts`]);
  });

  it("has no scheduled or collector workflow and no cron", async () => {
    const workflows = await files(".github/workflows", /\.ya?ml$/);
    expect(workflows.length).toBeGreaterThan(0);
    expect(await matching(workflows, /^\s*schedule\s*:|collector|aboutamazon|runCollection/im)).toEqual([]);
    expect(await matching(await files(".", /^vercel\.json$/), /crons/)).toEqual([]);
  });

  it("never enables a collection source or creates a collector in migrations", async () => {
    const migrations = await files("supabase/migrations", /\.sql$/);
    expect(migrations.length).toBeGreaterThan(0);
    expect(await matching(migrations, /enabled\s*=\s*true|set\s+enabled|insert\s+into\s+private\.collector_users/i)).toEqual([]);
    const policy = await readFile("supabase/migrations/20261011110237_manual_source_policy.sql", "utf8");
    // The aboutamazon row: manual citation allowed, collection disabled.
    expect(policy).toMatch(/'amazon-aboutamazon-news',[\s\S]*?\n\s*false,\n\s*true\n/);
  });
});

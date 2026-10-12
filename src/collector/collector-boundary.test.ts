import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findBoundaryViolations } from "@/test/collector-boundary";

// The collector is a pure foundation: no database client or driver, no server
// modules, no network access, no sale lifecycle. These checks are syntax
// based, so comments never count and non-database calls such as
// createHash().update() or searchParams.delete() are allowed.

async function collectorSources(dir = "src/collector"): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return collectorSources(path);
      return Promise.resolve(/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : []);
    }),
  );
  return nested.flat();
}

const FILE = "src/collector/synthetic.ts";

function rules(code: string, fileName = FILE) {
  return findBoundaryViolations(code, fileName).map((violation) => violation.rule);
}

describe("collector security boundary (real sources)", () => {
  it("covers every collector source file", async () => {
    const files = await collectorSources();
    expect(files.length).toBeGreaterThanOrEqual(6);
  });

  it("has no boundary violations", async () => {
    for (const file of await collectorSources()) {
      expect({ file, violations: findBoundaryViolations(await readFile(file, "utf8"), file) }).toEqual({
        file,
        violations: [],
      });
    }
  });
});

describe("collector security boundary (negative controls)", () => {
  it.each([
    ["A: Supabase import", 'import { createClient } from "@supabase/supabase-js";', "db_import"],
    ["Supabase SSR import", 'import { createServerClient } from "@supabase/ssr";', "db_import"],
    ["Supabase CLI package", 'import x from "supabase";', "db_import"],
    ["pg driver", 'import { Pool } from "pg";', "db_import"],
    ["postgres driver", 'import postgres from "postgres";', "db_import"],
    ["dynamic DB import", 'const m = await import("@supabase/supabase-js");', "db_import"],
    ["require DB driver", 'const pg = require("pg");', "db_import"],
    ["re-export of a DB module", 'export { createClient } from "@supabase/supabase-js";', "db_import"],
    ["B: @/server import", 'import { createAdminSupabaseClient } from "@/server/supabase/admin-client";', "server_import"],
    ["@/server root import", 'import * as s from "@/server";', "server_import"],
    ["relative server import", 'import { getSupabasePublicEnv } from "../server/env";', "server_import"],
    ["dynamic server import", 'await import("@/server/data/admin-sale-create");', "server_import"],
    ["C: from().insert()", 'await client.from("collection_candidates").insert({});', "db_query"],
    ["D: from().update()", 'await client.from("collection_candidates").update({}).eq("id", 1);', "db_query"],
    ["E: from().delete()", 'await client.from("collection_candidates").delete().eq("id", 1);', "db_query"],
    ["upsert", 'await client.from("collection_candidates").upsert({});', "db_query"],
    ["rpc", 'await client.rpc("submit_collection_candidate", {});', "db_query"],
    ["select chain", 'await client.from("retailers").select("id");', "db_query"],
    ["sql tag", "await sql`delete from collection_candidates`;", "sql_tag"],
    ["global fetch", 'await fetch("https://example.test/feed");', "network"],
    ["globalThis.fetch", 'await globalThis.fetch("https://example.test/feed");', "network"],
    ["node:https", 'import https from "node:https";', "network"],
    ["undici", 'import { request } from "undici";', "network"],
    ["sale lifecycle status", 'const status = "published";', "domain"],
    ["sale_events table", 'const table = "sale_events";', "domain"],
  ])("detects %s", (_label, code, rule) => {
    expect(rules(code)).toContain(rule);
  });

  it.each([
    ["F: createHash().update()", 'import { createHash } from "node:crypto"; createHash("sha256").update("x").digest("hex");'],
    ["G: searchParams.delete()", 'const url = new URL("https://example.test/?utm_source=x"); url.searchParams.delete("utm_source");'],
    ["Map/Set delete", "const m = new Map(); m.delete(1); new Set([1]).delete(1);"],
    ["Array.from", "const a = Array.from({ length: 3 });"],
    ["Buffer.from", 'const b = Buffer.from("x", "utf8");'],
    ["injected fetcher", "const document = await fetcher.fetch(url);"],
    ["injected writer", "await writer.submit(input);"],
    ["sibling collector import", 'import { validateCandidate } from "./validate";'],
    ["lib import", 'import { addDays } from "@/lib/jst";'],
    ["comments only", "// client.from('sale_events').update({ status: 'published' })\n/* import pg from \"pg\" */"],
  ])("allows %s", (_label, code) => {
    expect(rules(code)).toEqual([]);
  });

  it("resolves relative imports against the importing file", () => {
    expect(rules('import x from "../../server/env";', "src/collector/adapters/amazon.ts")).toContain("server_import");
    expect(rules('import x from "../lib/jst";', FILE)).toEqual([]);
  });
});

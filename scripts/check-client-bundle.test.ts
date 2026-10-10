import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanDirectory, scanSource } from "./check-client-bundle.mjs";

// Fixture strings below are fake and exist only to exercise the rules.
const FAKE_PUBLISHABLE = "sb_publishable_FAKE0000fixture";
const FAKE_SECRET = "sb_secret_FAKE0000fixture";

describe("scanSource", () => {
  it.each([
    ['import "@supabase/supabase-js"', "supabase-client-library"],
    ['"@supabase/postgrest-js"', "supabase-client-library"],
    ['headers:{"X-Client-Info":"x"}', "supabase-client-library"],
    ['fetch("https://abcdefghijklmnopqrst.supabase.co/rest/v1")', "hosted-supabase-url"],
    ['"abcdefghijklmnopqrst.supabase.co"', "hosted-supabase-url"],
    [`const k="${FAKE_PUBLISHABLE}"`, "supabase-key-prefix"],
    [`const k="${FAKE_SECRET}"`, "supabase-key-prefix"],
  ])("detects %s", (source, rule) => {
    expect(scanSource(source)).toContain(rule);
  });

  it.each([
    'console.log("see https://supabase.com/docs")',
    'const a="https://www.supabase.com"',
    "function x(){return 1+1}",
    'const s="supabase"',
  ])("does not flag harmless text: %s", (source) => {
    expect(scanSource(source)).toEqual([]);
  });
});

describe("scanDirectory", () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reports file and rule names only, never matched values", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bundle-check-"));
    await mkdir(path.join(dir, "chunks"), { recursive: true });
    await writeFile(path.join(dir, "chunks", "bad.js"), `var k="${FAKE_SECRET}";`);
    await writeFile(path.join(dir, "chunks", "ok.js"), "var x=1;");
    await writeFile(path.join(dir, "ignored.css"), `.a{content:"${FAKE_SECRET}"}`);

    const result = await scanDirectory(dir);

    expect(result.fileCount).toBe(2);
    expect(result.findings).toEqual([
      { file: path.join("chunks", "bad.js"), rule: "supabase-key-prefix" },
    ]);
    expect(JSON.stringify(result)).not.toContain(FAKE_SECRET);
  });

  it("passes a directory of harmless JavaScript", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "bundle-check-"));
    await writeFile(path.join(dir, "a.js"), 'console.log("https://supabase.com")');

    await expect(scanDirectory(dir)).resolves.toEqual({ fileCount: 1, findings: [] });
  });
});

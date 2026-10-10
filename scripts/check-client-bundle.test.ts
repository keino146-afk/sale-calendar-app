import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { scanBuildOutput, scanDirectory, scanSource } from "./check-client-bundle.mjs";

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

describe("scanBuildOutput", () => {
  const FAKE_HOST_URL = "https://abcdefghijklmnopqrst.supabase.co";
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function makeNextDir(files: Record<string, string>) {
    dir = await mkdtemp(path.join(tmpdir(), "bundle-check-next-"));
    const nextDir = path.join(dir, ".next");
    for (const [relative, content] of Object.entries(files)) {
      const full = path.join(nextDir, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    return nextDir;
  }

  const SAFE_STATIC = { "static/chunks/app.js": "var x=1;" };

  it("flags a library marker in static JS", async () => {
    const nextDir = await makeNextDir({
      "static/chunks/app.js": 'import "@supabase/supabase-js";',
    });

    const result = await scanBuildOutput(nextDir);

    expect(result.findings).toEqual([
      { file: path.join("static", "chunks", "app.js"), rule: "supabase-client-library" },
    ]);
  });

  it("flags a hosted Supabase URL in prerendered HTML", async () => {
    const nextDir = await makeNextDir({
      ...SAFE_STATIC,
      "server/app/index.html": `<p>${FAKE_HOST_URL}</p>`,
    });

    const result = await scanBuildOutput(nextDir);

    expect(result.findings).toEqual([
      { file: path.join("server", "app", "index.html"), rule: "hosted-supabase-url" },
    ]);
  });

  it("flags a key prefix in prerendered RSC", async () => {
    const nextDir = await makeNextDir({
      ...SAFE_STATIC,
      "server/app/index.rsc": `0:["${FAKE_PUBLISHABLE}"]`,
    });

    const result = await scanBuildOutput(nextDir);

    expect(result.findings).toEqual([
      { file: path.join("server", "app", "index.rsc"), rule: "supabase-key-prefix" },
    ]);
  });

  it("scans nested segment RSC files", async () => {
    const nextDir = await makeNextDir({
      ...SAFE_STATIC,
      "server/app/index.segments/__PAGE__.segment.rsc": `0:["${FAKE_SECRET}"]`,
    });

    const result = await scanBuildOutput(nextDir);

    expect(result.findings).toEqual([
      {
        file: path.join("server", "app", "index.segments", "__PAGE__.segment.rsc"),
        rule: "supabase-key-prefix",
      },
    ]);
  });

  it("does not scan server-side JavaScript", async () => {
    const nextDir = await makeNextDir({
      ...SAFE_STATIC,
      "server/app/page.js": 'require("@supabase/supabase-js");',
      "server/chunks/ssr/lib.js": `var u="${FAKE_HOST_URL}";`,
    });

    const result = await scanBuildOutput(nextDir);

    expect(result.findings).toEqual([]);
    expect(result.prerenderCount).toBe(0);
  });

  it("passes safe JS, HTML, and RSC", async () => {
    const nextDir = await makeNextDir({
      ...SAFE_STATIC,
      "server/app/index.html": "<p>see https://supabase.com/docs</p>",
      "server/app/index.rsc": '0:["hello"]',
    });

    await expect(scanBuildOutput(nextDir)).resolves.toEqual({
      staticJsCount: 1,
      prerenderCount: 2,
      findings: [],
    });
  });

  it("CLI output names files and rules but never matched values", async () => {
    const nextDir = await makeNextDir({
      "static/chunks/app.js": `var k="${FAKE_SECRET}";`,
      "server/app/index.html": `<p>${FAKE_HOST_URL}</p>`,
    });
    const script = fileURLToPath(new URL("./check-client-bundle.mjs", import.meta.url));

    const run = spawnSync(process.execPath, [script], {
      cwd: path.dirname(nextDir),
      encoding: "utf8",
    });

    expect(run.status).toBe(1);
    const output = `${run.stdout}${run.stderr}`;
    expect(output).toContain("supabase-key-prefix");
    expect(output).toContain("hosted-supabase-url");
    expect(output).not.toContain(FAKE_SECRET);
    expect(output).not.toContain(FAKE_HOST_URL);
    expect(output).not.toContain("abcdefghijklmnopqrst");
  });
});

import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateScan,
  readExpectedPrerenderAppRoutes,
  scanBuildOutput,
  scanDirectory,
  scanSource,
} from "./check-client-bundle.mjs";

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
  // Fake preview-mode secrets: must never appear in any output.
  const FAKE_PREVIEW = {
    previewModeId: "FAKE_PREVIEW_MODE_ID_0000",
    previewModeSigningKey: "FAKE_PREVIEW_SIGNING_KEY_0000",
    previewModeEncryptionKey: "FAKE_PREVIEW_ENCRYPTION_KEY_0000",
  };
  const MANIFEST_TWO_APP_PAGES = {
    version: 4,
    routes: {
      "/_global-error": { srcRoute: "/_global-error", dataRoute: "/_global-error.rsc" },
      "/_not-found": { srcRoute: "/_not-found", dataRoute: "/_not-found.rsc" },
      "/favicon.ico": { srcRoute: "/favicon.ico", dataRoute: null },
    },
    dynamicRoutes: {},
    notFoundRoutes: [],
    preview: FAKE_PREVIEW,
  };
  const MANIFEST_METADATA_ONLY = {
    version: 4,
    routes: { "/favicon.ico": { srcRoute: "/favicon.ico", dataRoute: null } },
    dynamicRoutes: {},
    notFoundRoutes: [],
    preview: FAKE_PREVIEW,
  };
  const SAFE_STATIC = { "static/chunks/app.js": "var x=1;" };
  const SAFE_PRERENDER = {
    "server/app/_not-found.html": "<p>not found</p>",
    "server/app/_not-found.rsc": '0:["ok"]',
  };

  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function makeNextDir(
    files: Record<string, string>,
    manifest: object | null = MANIFEST_TWO_APP_PAGES,
  ) {
    dir = await mkdtemp(path.join(tmpdir(), "bundle-check-next-"));
    const nextDir = path.join(dir, ".next");
    const all: Record<string, string> = { ...files };
    if (manifest !== null) all["prerender-manifest.json"] = JSON.stringify(manifest);
    for (const [relative, content] of Object.entries(all)) {
      const full = path.join(nextDir, relative);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, content);
    }
    return nextDir;
  }

  function runCli(nextDir: string) {
    const script = fileURLToPath(new URL("./check-client-bundle.mjs", import.meta.url));
    const run = spawnSync(process.execPath, [script], {
      cwd: path.dirname(nextDir),
      encoding: "utf8",
    });
    return { status: run.status, output: `${run.stdout}${run.stderr}` };
  }

  it("flags a library marker in static JS", async () => {
    const nextDir = await makeNextDir({
      ...SAFE_PRERENDER,
      "static/chunks/app.js": 'import "@supabase/supabase-js";',
    });

    const result = await scanBuildOutput(nextDir);

    expect(result.findings).toEqual([
      { file: path.join("static", "chunks", "app.js"), rule: "supabase-client-library" },
    ]);
  });

  it.each([
    ["server/app/index.html", `<p>${FAKE_HOST_URL}</p>`, "hosted-supabase-url"],
    ["server/app/index.rsc", '0:["sb_publishable_FAKE0000fixture"]', "supabase-key-prefix"],
    [
      "server/app/index.segments/__PAGE__.segment.rsc",
      '0:["sb_secret_FAKE0000fixture"]',
      "supabase-key-prefix",
    ],
    ["server/pages/404.html", `<p>${FAKE_HOST_URL}</p>`, "hosted-supabase-url"],
    ["server/pages/500.html", "<p>sb_secret_FAKE0000fixture</p>", "supabase-key-prefix"],
    [
      "server/route-cache/app-page/abc123/$/_not-found.html",
      `<p>${FAKE_HOST_URL}</p>`,
      "hosted-supabase-url",
    ],
    [
      "server/route-cache/app-page/abc123/$/_not-found.rsc",
      '0:["sb_publishable_FAKE0000fixture"]',
      "supabase-key-prefix",
    ],
  ])("scans %s", async (file, content, rule) => {
    const nextDir = await makeNextDir({ ...SAFE_STATIC, [file]: content });

    const result = await scanBuildOutput(nextDir);

    expect(result.findings).toEqual([{ file: path.join(...file.split("/")), rule }]);
  });

  it("does not scan server-side JavaScript or .next/cache", async () => {
    const nextDir = await makeNextDir({
      ...SAFE_STATIC,
      ...SAFE_PRERENDER,
      "server/app/page.js": 'require("@supabase/supabase-js");',
      "server/chunks/ssr/lib.js": `var u="${FAKE_HOST_URL}";`,
      "cache/fetch-cache/entry.html": `<p>${FAKE_HOST_URL}</p>`,
    });

    const result = await scanBuildOutput(nextDir);

    expect(result.findings).toEqual([]);
    expect(result.htmlCount).toBe(1);
    expect(result.rscCount).toBe(1);
  });

  it("passes safe JS, HTML, and RSC with counts", async () => {
    const nextDir = await makeNextDir({
      ...SAFE_STATIC,
      "server/app/_not-found.html": "<p>see https://supabase.com/docs</p>",
      "server/app/_not-found.rsc": '0:["hello"]',
      "server/pages/404.html": "<p>404</p>",
      "server/route-cache/app-page/abc123/$/_global-error.rsc": '0:["ok"]',
    });

    const result = await scanBuildOutput(nextDir);

    expect(result).toEqual({
      staticJsCount: 1,
      htmlCount: 2,
      rscCount: 2,
      expectedPrerenderAppRoutes: 2,
      findings: [],
    });
    expect(evaluateScan(result)).toBeNull();
  });

  it("counts only routes with an .rsc data route as expected app pages", async () => {
    const nextDir = await makeNextDir({ ...SAFE_STATIC }, MANIFEST_METADATA_ONLY);

    await expect(readExpectedPrerenderAppRoutes(nextDir)).resolves.toBe(0);
  });

  it("fails when prerendered app pages are expected but none are found", async () => {
    const nextDir = await makeNextDir({ ...SAFE_STATIC });

    const result = await scanBuildOutput(nextDir);

    expect(result.expectedPrerenderAppRoutes).toBe(2);
    expect(evaluateScan(result)).toBe("prerender artifacts expected but none found.");
  });

  it("passes with no HTML/RSC when no prerendered app pages are expected", async () => {
    const nextDir = await makeNextDir({ ...SAFE_STATIC }, MANIFEST_METADATA_ONLY);

    const result = await scanBuildOutput(nextDir);

    expect(result.htmlCount + result.rscCount).toBe(0);
    expect(evaluateScan(result)).toBeNull();
  });

  it("fails when the prerender manifest is missing", async () => {
    const nextDir = await makeNextDir({ ...SAFE_STATIC, ...SAFE_PRERENDER }, null);

    const result = await scanBuildOutput(nextDir);

    expect(result.expectedPrerenderAppRoutes).toBeNull();
    expect(evaluateScan(result)).toBe(".next/prerender-manifest.json not found or unreadable.");
  });

  it("CLI success output contains counts only", async () => {
    const nextDir = await makeNextDir({ ...SAFE_STATIC, ...SAFE_PRERENDER });

    const { status, output } = runCli(nextDir);

    expect(status).toBe(0);
    expect(output.trim()).toBe(
      "check-client-bundle: OK (1 static JS, 1 HTML, 1 RSC, 2 expected prerendered app pages)",
    );
  });

  it("CLI failure output names files and rules but never matched values or manifest secrets", async () => {
    const nextDir = await makeNextDir({
      "static/chunks/app.js": `var k="${FAKE_SECRET}";`,
      "server/route-cache/app-page/abc123/$/_not-found.html": `<p>${FAKE_HOST_URL}</p>`,
    });

    const { status, output } = runCli(nextDir);

    expect(status).toBe(1);
    expect(output).toContain("supabase-key-prefix");
    expect(output).toContain("hosted-supabase-url");
    expect(output).not.toContain(FAKE_SECRET);
    expect(output).not.toContain(FAKE_HOST_URL);
    expect(output).not.toContain("abcdefghijklmnopqrst");
    for (const secret of Object.values(FAKE_PREVIEW)) {
      expect(output).not.toContain(secret);
    }
  });

  it("CLI never prints manifest secrets on manifest-based failure", async () => {
    const nextDir = await makeNextDir({ ...SAFE_STATIC });

    const { status, output } = runCli(nextDir);

    expect(status).toBe(1);
    expect(output).toContain("prerender artifacts expected but none found.");
    for (const secret of Object.values(FAKE_PREVIEW)) {
      expect(output).not.toContain(secret);
    }
  });
});

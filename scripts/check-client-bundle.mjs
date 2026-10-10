// Fails if browser-delivered build output contains Supabase client library
// code, a hosted Supabase project URL, or a Supabase API key prefix.
// Scanned: .next/static/**/*.js and prerendered .next/server/**/*.{html,rsc}
// (app/, pages/, and route-cache/, which Next.js uses when a deployment
// adapter is active, e.g. on Vercel).
// Server JS (.next/server/**/*.js) is intentionally not scanned: it may
// legitimately bundle @supabase/supabase-js.
// The prerender manifest is used only to know whether prerendered App Router
// pages are expected, so an empty scan cannot pass silently.
// Reports only counts, file names, and rule names, never matched text.

import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RULES = [
  {
    // String literals that survive minification (verified in
    // node_modules/@supabase/{supabase-js,postgrest-js}/dist).
    name: "supabase-client-library",
    pattern: /@supabase\/supabase-js|@supabase\/postgrest-js|X-Client-Info/,
  },
  {
    // <project>.supabase.co, but not supabase.com or other words.
    name: "hosted-supabase-url",
    pattern: /[a-z0-9-]+\.supabase\.co(?![a-z0-9-])/i,
  },
  {
    name: "supabase-key-prefix",
    pattern: /sb_(?:publishable|secret)_/,
  },
];

export function scanSource(source) {
  return RULES.filter((rule) => rule.pattern.test(source)).map((rule) => rule.name);
}

async function listFiles(dir, extensions) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(fullPath, extensions)));
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function scanDirectory(dir, extensions = [".js"], baseDir = dir) {
  const files = await listFiles(dir, extensions);
  const findings = [];
  for (const file of files) {
    const rules = scanSource(await readFile(file, "utf8"));
    for (const rule of rules) {
      findings.push({ file: path.relative(baseDir, file), rule });
    }
  }
  return { fileCount: files.length, findings };
}

async function scanIfPresent(dir, extensions, baseDir) {
  try {
    return await scanDirectory(dir, extensions, baseDir);
  } catch (error) {
    if (error && error.code === "ENOENT") return { fileCount: 0, findings: [] };
    throw error;
  }
}

// Number of prerendered App Router pages (routes with an .rsc data route).
// Only `routes[*].dataRoute` is read; other manifest fields (including the
// preview-mode secrets) are never inspected or output.
// Returns null if the manifest is missing or unreadable.
export async function readExpectedPrerenderAppRoutes(nextDir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(nextDir, "prerender-manifest.json"), "utf8"));
  } catch {
    return null;
  }
  const routes = manifest && typeof manifest.routes === "object" ? manifest.routes : null;
  if (routes === null) return null;
  return Object.values(routes).filter(
    (route) => route && typeof route.dataRoute === "string" && route.dataRoute.endsWith(".rsc"),
  ).length;
}

// Scans the browser-delivered parts of a Next.js build directory (.next).
export async function scanBuildOutput(nextDir) {
  const staticResult = await scanDirectory(path.join(nextDir, "static"), [".js"], nextDir);
  const serverDir = path.join(nextDir, "server");
  const htmlResult = await scanIfPresent(serverDir, [".html"], nextDir);
  const rscResult = await scanIfPresent(serverDir, [".rsc"], nextDir);

  return {
    staticJsCount: staticResult.fileCount,
    htmlCount: htmlResult.fileCount,
    rscCount: rscResult.fileCount,
    expectedPrerenderAppRoutes: await readExpectedPrerenderAppRoutes(nextDir),
    findings: [...staticResult.findings, ...htmlResult.findings, ...rscResult.findings],
  };
}

// Returns null when the build output passes, otherwise a generic reason.
export function evaluateScan(result) {
  if (result.staticJsCount === 0) {
    return "no JavaScript files found in .next/static.";
  }
  if (result.expectedPrerenderAppRoutes === null) {
    return ".next/prerender-manifest.json not found or unreadable.";
  }
  if (result.findings.length > 0) {
    return "forbidden content found in browser-delivered output:";
  }
  if (result.expectedPrerenderAppRoutes > 0 && result.htmlCount + result.rscCount === 0) {
    return "prerender artifacts expected but none found.";
  }
  return null;
}

async function main() {
  let result;
  try {
    result = await scanBuildOutput(path.resolve(".next"));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      console.error("check-client-bundle: .next/static not found. Run `npm run build` first.");
      process.exit(1);
    }
    throw error;
  }

  const failure = evaluateScan(result);
  if (failure !== null) {
    console.error(`check-client-bundle: ${failure}`);
    for (const finding of result.findings) {
      console.error(`  ${finding.file}: ${finding.rule}`);
    }
    process.exit(1);
  }

  console.log(
    `check-client-bundle: OK (${result.staticJsCount} static JS, ${result.htmlCount} HTML, ${result.rscCount} RSC, ${result.expectedPrerenderAppRoutes} expected prerendered app pages)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

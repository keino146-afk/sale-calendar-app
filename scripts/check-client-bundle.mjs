// Fails if browser-delivered build output contains Supabase client library
// code, a hosted Supabase project URL, or a Supabase API key prefix.
// Scanned: .next/static/**/*.js and prerendered .next/server/app/**/*.{html,rsc}.
// Server JS (.next/server/**/*.js) is intentionally not scanned: it may
// legitimately bundle @supabase/supabase-js.
// Reports only file names and rule names, never matched text.

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

// Scans the browser-delivered parts of a Next.js build directory (.next).
export async function scanBuildOutput(nextDir) {
  const staticResult = await scanDirectory(path.join(nextDir, "static"), [".js"], nextDir);

  let prerenderResult = { fileCount: 0, findings: [] };
  try {
    prerenderResult = await scanDirectory(
      path.join(nextDir, "server", "app"),
      [".html", ".rsc"],
      nextDir,
    );
  } catch (error) {
    if (!(error && error.code === "ENOENT")) throw error;
  }

  return {
    staticJsCount: staticResult.fileCount,
    prerenderCount: prerenderResult.fileCount,
    findings: [...staticResult.findings, ...prerenderResult.findings],
  };
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

  if (result.staticJsCount === 0) {
    console.error("check-client-bundle: no JavaScript files found in .next/static.");
    process.exit(1);
  }

  if (result.findings.length > 0) {
    console.error("check-client-bundle: forbidden content found in browser-delivered output:");
    for (const finding of result.findings) {
      console.error(`  ${finding.file}: ${finding.rule}`);
    }
    process.exit(1);
  }

  console.log(
    `check-client-bundle: OK (${result.staticJsCount} static JS, ${result.prerenderCount} prerendered HTML/RSC files scanned)`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

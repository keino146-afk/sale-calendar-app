// Fails if browser-delivered JavaScript (.next/static/**/*.js) contains
// Supabase client library code, a hosted Supabase project URL, or a Supabase
// API key prefix. Reports only file names and rule names, never matched text.

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

async function listJsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsFiles(fullPath)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }
  return files;
}

export async function scanDirectory(dir) {
  const files = await listJsFiles(dir);
  const findings = [];
  for (const file of files) {
    const rules = scanSource(await readFile(file, "utf8"));
    for (const rule of rules) {
      findings.push({ file: path.relative(dir, file), rule });
    }
  }
  return { fileCount: files.length, findings };
}

async function main() {
  const staticDir = path.resolve(".next/static");
  let result;
  try {
    result = await scanDirectory(staticDir);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      console.error("check-client-bundle: .next/static not found. Run `npm run build` first.");
      process.exit(1);
    }
    throw error;
  }

  if (result.fileCount === 0) {
    console.error("check-client-bundle: no JavaScript files found in .next/static.");
    process.exit(1);
  }

  if (result.findings.length > 0) {
    console.error("check-client-bundle: forbidden content found in client bundle:");
    for (const finding of result.findings) {
      console.error(`  ${finding.file}: ${finding.rule}`);
    }
    process.exit(1);
  }

  console.log(`check-client-bundle: OK (${result.fileCount} files scanned)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

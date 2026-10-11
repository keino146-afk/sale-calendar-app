import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Static guards for the admin/auth boundary. They read source files, so they
// fail as soon as a forbidden pattern is introduced anywhere under src/.

async function sourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return /\.(ts|tsx|mts|js|mjs)$/.test(entry.name) ? [path] : [];
    }),
  );
  return files.flat();
}

const ALL = await sourceFiles("src");
const APP_CODE = ALL.filter((file) => !/\.test\.(ts|tsx)$/.test(file) && !file.startsWith("src/test/"));

async function filesMatching(files: string[], pattern: RegExp): Promise<string[]> {
  const hits: string[] = [];
  for (const file of files) {
    if (pattern.test(await readFile(file, "utf8"))) hits.push(file);
  }
  return hits;
}

describe("admin security boundary", () => {
  it("never uses a service_role or secret key", async () => {
    // Comments may mention service_role; code may not reference it.
    const hits: string[] = [];
    for (const file of APP_CODE) {
      const code = (await readFile(file, "utf8")).replace(/^\s*\/\/.*$/gm, "");
      if (/service_role|SERVICE_ROLE|SUPABASE_SECRET/.test(code)) hits.push(file);
    }
    expect(hits).toEqual([]);
    // "sb_secret_" appears only in env.ts, which rejects such keys.
    expect(await filesMatching(APP_CODE, /sb_secret_/)).toEqual(["src/server/env.ts"]);
  });

  it("never exposes Supabase settings to the browser", async () => {
    expect(await filesMatching(APP_CODE, /NEXT_PUBLIC_/)).toEqual([]);
  });

  it("creates no browser Supabase client", async () => {
    expect(await filesMatching(APP_CODE, /createBrowserClient/)).toEqual([]);
  });

  it("has no Client Components", async () => {
    expect(await filesMatching(APP_CODE, /^\s*["']use client["']/m)).toEqual([]);
  });

  it("imports Supabase packages only from src/server", async () => {
    const importers = await filesMatching(APP_CODE, /from ["']@supabase\//);
    expect(importers.every((file) => file.startsWith("src/server/"))).toBe(true);
  });

  it("reads admin_users only through the database function", async () => {
    // Only the generated schema types mention the table.
    expect(await filesMatching(APP_CODE, /admin_users/)).toEqual([
      "src/server/supabase/database.types.ts",
    ]);
  });

  it("never renders or logs raw error messages in pages and auth code", async () => {
    const uiAndAuth = APP_CODE.filter(
      (file) =>
        file.startsWith("src/app/") ||
        file.startsWith("src/components/") ||
        file.startsWith("src/server/auth/") ||
        file === "src/proxy.ts",
    );
    expect(await filesMatching(uiAndAuth, /error\.message|\.stack\b/)).toEqual([]);
  });

  it("never updates lifecycle columns directly", async () => {
    expect(await filesMatching(APP_CODE, /\.update\(|status\s*:\s*["']published/)).toEqual([]);
  });

  it("keeps public pages free of admin session code", async () => {
    const publicPages = APP_CODE.filter(
      (file) => file.startsWith("src/app/") && !file.startsWith("src/app/admin/"),
    );
    expect(publicPages.length).toBeGreaterThan(0);
    expect(await filesMatching(publicPages, /admin-client|admin-session|admin-auth|next\/headers/)).toEqual(
      [],
    );
  });

  it("guards every admin page with requireAdmin, except the login page", async () => {
    const pages = APP_CODE.filter(
      (file) => file.startsWith("src/app/admin/") && file.endsWith("page.tsx") && !file.includes("/login/"),
    );
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(await readFile(page, "utf8")).toMatch(/await requireAdmin\(\)/);
    }
  });
});

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
// Code that talks to Supabase. src/collector is excluded from the
// query-builder write checks because it never imports a Supabase client
// (enforced in src/collector/collector.test.ts); its .update()/.delete() calls
// are on hashes and URLSearchParams.
const DATA_CODE = APP_CODE.filter((file) => !file.startsWith("src/collector/"));

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

  it("has exactly one Client Component: the admin home link", async () => {
    // Approved exception (Phase 6F add-on). Any other "use client" fails.
    expect(await filesMatching(APP_CODE, /^\s*["']use client["']/m)).toEqual(["src/components/AdminHomeLink.tsx"]);
  });

  it("keeps the admin home link free of server, Supabase, env and storage code", async () => {
    const code = await readFile("src/components/AdminHomeLink.tsx", "utf8");
    const imports = [...code.matchAll(/^import[^;]*from\s+["']([^"']+)["']/gm)].map(([, source]) => source);
    expect(imports.sort()).toEqual(["next/link", "react"]);
    expect(code).not.toMatch(/supabase|@\/server|process\.env|NEXT_PUBLIC|localStorage|sessionStorage|document\.cookie|service_role/i);
    // It asks only /admin/presence, never follows a redirect and never
    // sends credentials cross-origin.
    expect([...code.matchAll(/["'`](\/[a-z/]*)["'`]/g)].map(([, path]) => path).sort()).toEqual(["/admin", "/admin/presence"]);
    expect(code).toContain('redirect: "error"');
    expect(code).toContain('credentials: "same-origin"');
    expect(code).not.toContain('credentials: "include"');
  });

  it("answers admin presence read-only, without redirects or identity", async () => {
    const routes = APP_CODE.filter((file) => /\/route\.(ts|tsx)$/.test(file));
    expect(routes).toEqual(["src/app/admin/presence/route.ts"]);
    const code = (await readFile("src/app/admin/presence/route.ts", "utf8")).replace(/^\s*\/\/.*$/gm, "");
    expect([...code.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)].map(([, name]) => name)).toEqual(["GET"]);
    expect(code).toContain("isAdminRequest()");
    expect(code).not.toMatch(/requireAdmin|redirect\(|signOut|\.rpc\(|\.from\(|user\.id|email/);
    expect(code).toContain('"Cache-Control": "private, no-store"');
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
    expect(await filesMatching(DATA_CODE, /\.update\(|status\s*:\s*["']published/)).toEqual([]);
  });

  it("never writes tables directly (lifecycle changes go through RPCs)", async () => {
    expect(await filesMatching(DATA_CODE, /\.(upsert|delete)\(/)).toEqual([]);
    // The only INSERT is manual candidate creation (status left to the DB default).
    expect(await filesMatching(DATA_CODE, /\.insert\(/)).toEqual(["src/server/data/admin-sale-create.ts"]);
    const createCode = await readFile("src/server/data/admin-sale-create.ts", "utf8");
    expect(createCode).not.toMatch(/\bstatus\s*:/);
    expect(createCode).not.toMatch(/title_key\s*:|start_date_jst\s*:|published_at\s*:/);
  });

  it("has no unsafe type escapes in application code", async () => {
    expect(await filesMatching(APP_CODE, /\bas any\b|:\s*any\b|<any>|as unknown as/)).toEqual([]);
  });

  it("types the admin client with the narrowed insert schema", async () => {
    const client = await readFile("src/server/supabase/admin-client.ts", "utf8");
    expect(client).toContain("SupabaseClient<AppDatabase>");
    expect(client).not.toMatch(/createServerClient<Database>/);
  });

  it("calls only the known RPCs", async () => {
    const allowed = new Set([
      "current_user_is_admin",
      "import_collection_candidate",
      "is_allowed_manual_source",
      "publish_sale_event",
      "reject_sale_event",
      "archive_sale_event",
      "reopen_sale_event",
      "update_sale_event",
    ]);
    const used = new Set<string>();
    for (const file of APP_CODE) {
      for (const [, name] of (await readFile(file, "utf8")).matchAll(/\.rpc\(\s*["']([a-z_]+)["']/g)) {
        used.add(name);
      }
    }
    expect([...used].filter((name) => !allowed.has(name))).toEqual([]);
    expect(used.has("publish_sale_event")).toBe(true);
  });

  it("checks Origin and the admin session in every admin data action file", async () => {
    const actionFiles = APP_CODE.filter(
      (file) =>
        file.startsWith("src/app/admin/") && file.endsWith("actions.ts") && file !== "src/app/admin/actions.ts",
    );
    expect(actionFiles).toEqual(
      expect.arrayContaining(["src/app/admin/new/actions.ts", "src/app/admin/sales/[saleId]/actions.ts"]),
    );
    for (const file of actionFiles) {
      const code = await readFile(file, "utf8");
      expect(code).toMatch(/^"use server";/);
      expect(code).toContain("isSameOriginRequest()");
      expect(code).toContain("requireAdmin()");
      expect(code.indexOf("isSameOriginRequest()")).toBeLessThan(code.indexOf("requireAdmin()"));
    }
  });

  it("only reads collection candidates (no candidate mutation path)", async () => {
    expect(await filesMatching(DATA_CODE, /collection_candidates/)).toEqual([
      "src/server/data/admin-collection-candidates.ts",
      "src/server/supabase/database.types.ts",
    ]);
    const reader = await readFile("src/server/data/admin-collection-candidates.ts", "utf8");
    expect(reader).not.toMatch(/\.(insert|update|upsert|delete|rpc)\(/);
    // The collector write RPC is never used by the web app.
    expect(await filesMatching(APP_CODE, /submit_collection_candidate/)).toEqual([
      "src/server/supabase/database.types.ts",
    ]);
    // The only candidate state change is the atomic import RPC, called from
    // one data module that makes no other write.
    expect(await filesMatching(APP_CODE, /import_collection_candidate/)).toEqual([
      "src/server/data/admin-candidate-import.ts",
      "src/server/supabase/app-database.ts",
      "src/server/supabase/database.types.ts",
    ]);
    const importer = await readFile("src/server/data/admin-candidate-import.ts", "utf8");
    expect(importer.match(/\.rpc\(/g)).toHaveLength(1);
    expect(importer).not.toMatch(/\.(from|insert|update|upsert|delete)\(/);
  });

  it("edits sale content only through the update RPC, from one data module", async () => {
    // The only content change path is public.update_sale_event, called from
    // one data module that makes no other write (the .update( ban above stays).
    expect(await filesMatching(APP_CODE, /update_sale_event/)).toEqual([
      "src/server/data/admin-sale-edit.ts",
      "src/server/supabase/app-database.ts",
      "src/server/supabase/database.types.ts",
    ]);
    const editor = await readFile("src/server/data/admin-sale-edit.ts", "utf8");
    expect(editor.match(/\.rpc\(/g)).toHaveLength(1);
    expect(editor).not.toMatch(/\.(insert|update|upsert|delete)\(/);
    // Only the edit action uses the data module, and it never sends a status
    // or retailer from the form.
    expect(await filesMatching(APP_CODE, /admin-sale-edit"/)).toEqual([
      "src/app/admin/sales/[saleId]/edit/actions.ts",
      "src/app/admin/sales/[saleId]/edit/page.tsx",
    ]);
    const action = await readFile("src/app/admin/sales/[saleId]/edit/actions.ts", "utf8");
    expect(action).not.toMatch(/formData\.get\(["'](status|retailerId)["']\)/);
    expect(editor).not.toMatch(/p_status|p_retailer_id/);
  });

  it("never reads source policies directly (database check only)", async () => {
    expect(await filesMatching(APP_CODE, /collection_sources|collector_users/)).toEqual([]);
    expect(await filesMatching(APP_CODE, /is_allowed_manual_source/)).toEqual([
      "src/server/data/admin-source-policy.ts",
      "src/server/supabase/database.types.ts",
    ]);
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

  it("guards every admin page with requireAdmin, except the login and unavailable pages", async () => {
    const pages = APP_CODE.filter(
      (file) =>
        file.startsWith("src/app/admin/") &&
        file.endsWith("page.tsx") &&
        !file.includes("/login/") &&
        !file.includes("/unavailable/"),
    );
    expect(pages.length).toBeGreaterThan(0);
    for (const page of pages) {
      expect(await readFile(page, "utf8")).toMatch(/await requireAdmin\(\)/);
    }
  });

  it("keeps the unavailable page free of session, Auth and database code (no redirect loop)", async () => {
    const code = (await readFile("src/app/admin/unavailable/page.tsx", "utf8")).replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(
      /"use client"|@\/server\/|@supabase|next\/headers|next\/navigation|requireAdmin|checkAdmin|getUser|current_user_is_admin|\.rpc\(|\.from\(|auth\.|signOut|cookies|redirect\(|connection\(/,
    );
    // Only next/link is imported, and the only link goes back to /admin.
    expect([...code.matchAll(/from "([^"]+)"/g)].map(([, source]) => source)).toEqual(["next/link"]);
    expect([...code.matchAll(/href="([^"]+)"/g)].map(([, href]) => href)).toEqual(["/admin"]);
  });

  it("signs out globally only for a confirmed non-admin, never for a failed check", async () => {
    const strip = (code: string) => code.replace(/^\s*\/\/.*$/gm, "");
    const session = strip(await readFile("src/server/auth/admin-session.ts", "utf8"));
    expect(session).toContain('if (result.kind === "unavailable") redirect(ADMIN_UNAVAILABLE_PATH);');
    expect(session).toContain('if (authorization === "authorized") return { kind: "admin", supabase };');
    expect(session).toContain('if (authorization === "not_authorized") return { kind: "denied", supabase };');
    expect(session).toContain('return { kind: "unavailable" };');
    const auth = strip(await readFile("src/server/auth/admin-auth.ts", "utf8"));
    expect(auth).toMatch(/if \(authorization === "not_authorized"\) await signOutGlobally\(supabase\);\s*else await signOutLocally\(supabase\);/);
    // Only the admin-session helpers call auth.signOut().
    expect(await filesMatching(APP_CODE, /auth\.signOut\(/)).toEqual(["src/server/auth/admin-session.ts"]);
  });

  it("bounds admin screen reads only, never writes, the admin check or Auth", async () => {
    // Per-read abort signals (admin-read-timeout.ts) are used by the admin
    // screen-read modules only; no client-wide timeout exists.
    expect(await filesMatching(APP_CODE, /abortSignal\(|adminReadSignal/)).toEqual([
      "src/server/data/admin-collection-candidates.ts",
      "src/server/data/admin-read-timeout.ts",
      "src/server/data/admin-sale-create.ts",
      "src/server/data/admin-sale-edit.ts",
      "src/server/data/admin-sale-events.ts",
    ]);
    expect(await readFile("src/server/supabase/admin-client.ts", "utf8")).not.toMatch(/\bdb\s*:|timeout|abortSignal/i);

    // The admin check (kept without a timeout by design), the source
    // policy check, every write RPC, the insert and all Auth calls stay
    // without a signal: each call chain up to its end has no abortSignal.
    for (const file of APP_CODE) {
      const code = await readFile(file, "utf8");
      for (const match of code.matchAll(/\.(rpc|insert)\(|\bauth\.[a-zA-Z]+\(/g)) {
        const end = code.indexOf(";", match.index);
        expect(code.slice(match.index, end === -1 ? undefined : end), `${file}: ${match[0]}`).not.toMatch(/abortSignal|signal\s*:/);
      }
    }
    for (const file of [
      "src/server/auth/admin-session.ts",
      "src/server/auth/admin-auth.ts",
      "src/server/data/admin-source-policy.ts",
      "src/server/data/admin-sale-actions.ts",
      "src/server/data/admin-candidate-import.ts",
      "src/proxy.ts",
    ]) {
      expect(await readFile(file, "utf8"), file).not.toMatch(/abortSignal|adminReadSignal|AbortSignal/);
    }
  });
});

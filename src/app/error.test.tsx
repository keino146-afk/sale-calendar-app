import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import ErrorPage from "./error";

function failure() {
  const error = new Error("SECRET_MESSAGE sb_secret_FAKE relation private.admin_users") as Error & {
    digest?: string;
  };
  error.digest = "DIGEST_4242";
  error.stack = "Error: SECRET_STACK at /var/task/src/server/data/sale-events.ts:1:1";
  return error;
}

function render(retry = vi.fn()) {
  return renderToStaticMarkup(<ErrorPage error={failure()} retry={retry} />);
}

describe("error page", () => {
  it("shows a generic Japanese message as an alert, a retry button and a way home", () => {
    const html = render();

    expect(html).toMatch(/<section role="alert"[^>]*>/);
    expect(html).toMatch(/<h1[^>]*>エラーが発生しました<\/h1>/);
    expect(html).toContain("ページを正常に表示できませんでした。");
    expect(html).toMatch(/<button type="button"[^>]*>もう一度試す<\/button>/);
    expect(html).toMatch(/href="\/"[^>]*>ホームへ戻る</);
  });

  it("never renders the error's message, digest or stack", () => {
    const html = render();

    for (const leak of ["SECRET_MESSAGE", "sb_secret_", "private.admin_users", "DIGEST_4242", "SECRET_STACK", "/var/task"]) {
      expect(html).not.toContain(leak);
    }
  });

  it("is the minimal Client Component: retry only, no logging, no server code", async () => {
    const code = (await readFile("src/app/error.tsx", "utf8")).replace(/^\s*\/\/.*$/gm, "");
    expect(code).toMatch(/^"use client";/);
    expect(code).toContain("onClick={() => retry()}");
    expect(code).not.toMatch(/console\.|error\.(message|digest|stack)|\{error\}|@\/server|supabase|process\.env|fetch\(|reset/);
    const imports = [...code.matchAll(/^import[^;]*from\s+["']([^"']+)["']/gm)].map(([, source]) => source);
    expect(imports).toEqual(["next/link"]);
  });
});

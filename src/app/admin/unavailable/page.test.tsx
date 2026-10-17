import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import AdminLayout, { metadata } from "../layout";
import AdminUnavailablePage from "./page";

describe("/admin/unavailable", () => {
  it("shows fixed text and a link back to /admin only", () => {
    const html = renderToStaticMarkup(AdminUnavailablePage());

    expect(html).toContain("一時的に管理者情報を確認できません。少し待ってから再度お試しください。");
    expect([...html.matchAll(/href="([^"]+)"/g)].map(([, href]) => href)).toEqual(["/admin"]);
    expect(html).toContain("管理画面へ戻る");
    // Not a login screen: no password is asked for, and nothing says "not an admin".
    expect(html).not.toMatch(/<form|<input|password|パスワード|ログインできませんでした/);
  });

  it("is rendered without any request data, so it cannot depend on the session", () => {
    expect(AdminUnavailablePage.length).toBe(0);
  });

  it("stays inside the noindex admin layout", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
    expect(renderToStaticMarkup(AdminLayout({ children: AdminUnavailablePage() } as never))).toContain(
      "一時的に管理者情報を確認できません",
    );
  });
});

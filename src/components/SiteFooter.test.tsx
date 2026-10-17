import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SiteFooter } from "./SiteFooter";

describe("SiteFooter", () => {
  it("shows the approved disclaimer and operator label", () => {
    const html = renderToStaticMarkup(<SiteFooter />);

    expect(html).toMatch(/^<footer/);
    expect(html).toContain("掲載情報は確認時点のものです。");
    expect(html).toContain("セールの開催期間・内容は変更される場合があります。");
    expect(html).toContain("最新情報は各公式サイトをご確認ください。");
    expect(html).toContain("運営：セールカレンダー運営");
  });

  it("contains no contact details, links or data access", async () => {
    const html = renderToStaticMarkup(<SiteFooter />);
    expect(html).not.toMatch(/@|mailto:|https?:|<a |株式会社|お問い合わせ/);
    const code = await readFile("src/components/SiteFooter.tsx", "utf8");
    expect(code).not.toMatch(/["']use client["']|^import /m);
  });
});

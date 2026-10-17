import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import NotFound from "./not-found";

describe("not-found page", () => {
  it("explains the 404 in Japanese and links home and to the calendar", () => {
    const html = renderToStaticMarkup(NotFound());

    expect(html).toContain("404");
    expect(html).toMatch(/<h1[^>]*>ページが見つかりません<\/h1>/);
    expect(html).toContain("お探しのページは削除されたか、URLが変更された可能性があります。");
    expect(html).toMatch(/href="\/"[^>]*>ホームへ戻る</);
    expect(html).toMatch(/href="\/calendar"[^>]*>カレンダーを見る</);
    expect(html.match(/<h1/g)).toHaveLength(1);
  });

  it("shows the public footer and nothing internal", () => {
    const html = renderToStaticMarkup(NotFound());

    expect(html).toContain("運営：セールカレンダー運営");
    expect(html).not.toMatch(/admin|管理|supabase|error|stack|digest/i);
  });

  it("is a Server Component without data, session or metadata code", async () => {
    const code = await readFile("src/app/not-found.tsx", "utf8");
    expect(code).not.toMatch(/["']use client["']|@\/server|supabase|next\/headers|fetch\(|export const metadata|generateMetadata/);
  });
});

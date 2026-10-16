import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { publicPageMetadata, SITE_DESCRIPTION, SITE_NAME, SITE_URL, siteUrl } from "./site";

describe("site constants", () => {
  it("point at the Production origin, never a Preview deployment", () => {
    expect(SITE_URL).toBe("https://sale-calendar-app.vercel.app");
    expect(SITE_URL).not.toMatch(/-git-|kkkk|localhost|\/$/);
    expect(SITE_NAME).toBe("セールカレンダー");
    expect(SITE_DESCRIPTION).toContain("楽天市場・Amazon・Qoo10");
  });

  it("builds absolute Production URLs", () => {
    expect(siteUrl("/")).toBe("https://sale-calendar-app.vercel.app/");
    expect(siteUrl("/calendar")).toBe("https://sale-calendar-app.vercel.app/calendar");
    expect(siteUrl("/sitemap.xml")).toBe("https://sale-calendar-app.vercel.app/sitemap.xml");
  });
});

describe("publicPageMetadata", () => {
  it("sets canonical, Open Graph and a text-only Twitter card with the full title", () => {
    expect(publicPageMetadata({ path: "/calendar", title: "カレンダー", description: "説明" })).toEqual({
      title: "カレンダー",
      description: "説明",
      alternates: { canonical: "/calendar" },
      openGraph: {
        type: "website",
        siteName: "セールカレンダー",
        locale: "ja_JP",
        url: "/calendar",
        title: "カレンダー | セールカレンダー",
        description: "説明",
      },
      twitter: { card: "summary", title: "カレンダー | セールカレンダー", description: "説明" },
    });
  });

  it("leaves the document title to the root default when no title is given", () => {
    const metadata = publicPageMetadata({ path: "/", description: "説明" });

    expect(metadata).not.toHaveProperty("title");
    expect(metadata.openGraph).toMatchObject({ title: "セールカレンダー" });
    expect(metadata.twitter).toMatchObject({ title: "セールカレンダー" });
  });

  it("never adds images", () => {
    const metadata = publicPageMetadata({ path: "/", description: "説明" });

    expect(metadata.openGraph).not.toHaveProperty("images");
    expect(metadata.twitter).not.toHaveProperty("images");
  });

  it("keeps markup-like text as plain text, escaped when rendered as an attribute", () => {
    const title = `<script>alert("x")</script> & 'quote'`;
    const metadata = publicPageMetadata({ path: "/", title, description: title });

    // Passed through unchanged (no double escaping) ...
    expect(metadata.title).toBe(title);
    // ... and escaped by React when it becomes a <meta> attribute.
    const html = renderToStaticMarkup(createElement("meta", { content: metadata.description }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
    expect(html).toContain("&quot;x&quot;");
  });
});

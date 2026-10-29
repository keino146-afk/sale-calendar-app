import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OG_IMAGE, publicPageMetadata, SITE_DESCRIPTION, SITE_NAME, SITE_URL, siteUrl } from "./site";

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
  it("sets canonical, Open Graph and a large-image Twitter card with the full title and the shared image", () => {
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
        images: [
          {
            url: "/og/sale-calendar-og-v1.png",
            width: 1200,
            height: 630,
            alt: "セールカレンダー：お得なセールを見逃さない",
            type: "image/png",
          },
        ],
      },
      twitter: {
        card: "summary_large_image",
        title: "カレンダー | セールカレンダー",
        description: "説明",
        images: [{ url: "/og/sale-calendar-og-v1.png", alt: "セールカレンダー：お得なセールを見逃さない" }],
      },
    });
  });

  it("leaves the document title to the root default when no title is given", () => {
    const metadata = publicPageMetadata({ path: "/", description: "説明" });

    expect(metadata).not.toHaveProperty("title");
    expect(metadata.openGraph).toMatchObject({ title: "セールカレンダー" });
    expect(metadata.twitter).toMatchObject({ title: "セールカレンダー" });
  });

  it("uses only the one fixed, versioned image: no per-page or per-sale image", () => {
    const home = publicPageMetadata({ path: "/", description: "説明" });
    const sale = publicPageMetadata({ path: "/sales/x", title: "あるセール（楽天市場）", description: "別の説明" });

    expect(OG_IMAGE.url).toMatch(/^\/og\/sale-calendar-og-v\d+\.png$/);
    expect(home.openGraph).toMatchObject({ images: [OG_IMAGE] });
    expect(sale.openGraph).toMatchObject({ images: [OG_IMAGE] });
    expect(JSON.stringify(sale.openGraph?.images)).not.toMatch(/あるセール|楽天/);
    // Relative, so metadataBase (the Production origin) makes it absolute.
    expect(new URL(OG_IMAGE.url, SITE_URL).toString()).toBe(
      "https://sale-calendar-app.vercel.app/og/sale-calendar-og-v1.png",
    );
  });

  it("leaves out only the canonical URL and og:url with canonical: false", () => {
    const withUrl = publicPageMetadata({ path: "/sales/x", title: "T", description: "D" });
    const withoutUrl = publicPageMetadata({ path: "/sales/x", title: "T", description: "D", canonical: false });

    expect(withoutUrl).not.toHaveProperty("alternates");
    expect(withoutUrl.openGraph).not.toHaveProperty("url");
    expect(JSON.stringify(withoutUrl)).not.toContain("/sales/x");
    // Everything else is the same (toEqual treats an undefined property as absent).
    expect(withoutUrl).toEqual({
      ...withUrl,
      alternates: undefined,
      openGraph: { ...(withUrl.openGraph as object), url: undefined },
    });
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

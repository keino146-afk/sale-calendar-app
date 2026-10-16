import type { Metadata } from "next";

// The public site's identity, in one place. SITE_URL is the Production
// origin on purpose (not an env value): canonical URLs, Open Graph URLs and
// the sitemap must point there from every deployment, Preview included.
export const SITE_NAME = "セールカレンダー";
export const SITE_URL = "https://sale-calendar-app.vercel.app";
export const SITE_DESCRIPTION =
  "楽天市場・Amazon・Qoo10の大型セールの開催予定と開催中のセールをまとめて確認できるセールカレンダーです。";

// The absolute Production URL for a site path such as "/calendar".
export function siteUrl(path: string): string {
  return new URL(path, SITE_URL).toString();
}

// Canonical, Open Graph and Twitter metadata for one public page. Next.js
// replaces (does not merge) openGraph and twitter from parent layouts, so
// each page sets all of them. `title` is the page part only: the root
// layout's template adds " | セールカレンダー" to the document title, but not
// to openGraph/twitter titles, which therefore get the full title here.
// No images.
export function publicPageMetadata({
  path,
  title,
  description,
}: {
  path: string;
  title?: string;
  description: string;
}): Metadata {
  const fullTitle = title === undefined ? SITE_NAME : `${title} | ${SITE_NAME}`;
  return {
    ...(title !== undefined ? { title } : {}),
    description,
    alternates: { canonical: path },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: "ja_JP",
      url: path,
      title: fullTitle,
      description,
    },
    twitter: {
      card: "summary",
      title: fullTitle,
      description,
    },
  };
}

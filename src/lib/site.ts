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

// The one shared Open Graph / Twitter image of the public pages: a fixed
// picture (no logos, no sale details), so it reveals nothing about any sale.
// The version in the file name changes whenever the picture does, because
// social networks cache images by URL. Relative: metadataBase makes it an
// absolute Production URL.
export const OG_IMAGE = {
  url: "/og/sale-calendar-og-v1.png",
  width: 1200,
  height: 630,
  alt: "セールカレンダー：お得なセールを見逃さない",
  type: "image/png",
} as const;

// Canonical, Open Graph and Twitter metadata for one public page. Next.js
// replaces (does not merge) openGraph and twitter from parent layouts, so
// each page sets all of them. `title` is the page part only: the root
// layout's template adds " | セールカレンダー" to the document title, but not
// to openGraph/twitter titles, which therefore get the full title here.
// Every public page gets the shared image; pages that do not use this
// (admin, 404, a failed sale load) have none. `canonical: false` leaves out
// the canonical URL and og:url, for a page whose path is only valid on
// Production (a sale id) shown on another deployment.
export function publicPageMetadata({
  path,
  title,
  description,
  canonical = true,
}: {
  path: string;
  title?: string;
  description: string;
  canonical?: boolean;
}): Metadata {
  const fullTitle = title === undefined ? SITE_NAME : `${title} | ${SITE_NAME}`;
  return {
    ...(title !== undefined ? { title } : {}),
    description,
    ...(canonical ? { alternates: { canonical: path } } : {}),
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: "ja_JP",
      ...(canonical ? { url: path } : {}),
      title: fullTitle,
      description,
      images: [{ ...OG_IMAGE }],
    },
    twitter: {
      card: "summary_large_image",
      title: fullTitle,
      description,
      images: [{ url: OG_IMAGE.url, alt: OG_IMAGE.alt }],
    },
  };
}

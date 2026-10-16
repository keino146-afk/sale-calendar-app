import type { MetadataRoute } from "next";
import { siteUrl } from "@/lib/site";

// Guidance for crawlers only, not access control: the admin area is protected
// by its sign-in (proxy and requireAdmin) and also marks itself noindex.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/admin" },
    sitemap: siteUrl("/sitemap.xml"),
  };
}

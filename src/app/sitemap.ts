import type { MetadataRoute } from "next";
import { connection } from "next/server";
import { siteUrl } from "@/lib/site";
import { listSitemapSaleEvents } from "@/server/data/sale-events";

// Built per request: connection() keeps `next build` from reading Supabase.
// Lists the home page, the calendar and published sales that have not ended
// (Production URLs only). If sales cannot be read, the two fixed pages are
// still returned instead of an error.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  await connection();

  const entries: MetadataRoute.Sitemap = [{ url: siteUrl("/") }, { url: siteUrl("/calendar") }];
  try {
    const sales = await listSitemapSaleEvents({ now: new Date() });
    for (const sale of sales) {
      entries.push({ url: siteUrl(`/sales/${sale.id}`), lastModified: sale.updatedAt });
    }
  } catch (error) {
    // Log only the error class; messages may contain upstream details.
    console.error(`[sitemap] sale load failed: ${error instanceof Error ? error.name : "UnknownError"}`);
  }
  return entries;
}

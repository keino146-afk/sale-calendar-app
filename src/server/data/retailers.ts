import "server-only";

import { getPublicSupabaseClient } from "@/server/supabase/public-client";
import { DataAccessError, logSupabaseError } from "./errors";

export type RetailerDto = {
  id: string;
  slug: string;
  name: string;
  officialBaseUrl: string;
  sortOrder: number;
};

const RETAILER_COLUMNS = "id, slug, name, official_base_url, sort_order";

export async function listActiveRetailers(): Promise<RetailerDto[]> {
  const { data, error } = await getPublicSupabaseClient()
    .from("retailers")
    .select(RETAILER_COLUMNS)
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("slug", { ascending: true });

  if (error) {
    logSupabaseError("listActiveRetailers", error);
    throw new DataAccessError("Failed to load retailers");
  }

  return data.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    officialBaseUrl: row.official_base_url,
    sortOrder: row.sort_order,
  }));
}

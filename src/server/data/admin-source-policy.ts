import "server-only";

import type { AdminSupabaseClient } from "@/server/supabase/admin-client";
import { isOnOfficialDomain } from "@/lib/sale-candidate-form";

// Where a manually registered sale may cite its source. Two kinds of official
// source are accepted:
//   1. the retailer's own official domain (retailers.official_base_url),
//      checked here without a database call;
//   2. an approved official announcement source for that retailer (e.g.
//      Amazon's www.aboutamazon.jp news articles), checked by the database
//      through public.is_allowed_manual_source as the signed-in admin.
// The source policies themselves stay in schema private and are never read
// by the app. Anything other than an explicit true is not allowed (fail
// closed); a failed check is reported separately so the admin can retry.

export type SourceUrlCheck = "allowed" | "rejected" | "failed";

export async function checkSaleSourceUrl(
  supabase: AdminSupabaseClient,
  retailer: { id: string; officialBaseUrl: string },
  sourceUrl: string,
): Promise<SourceUrlCheck> {
  if (isOnOfficialDomain(sourceUrl, retailer.officialBaseUrl)) return "allowed";

  let hostname: string;
  try {
    hostname = new URL(sourceUrl).hostname;
  } catch {
    return "rejected";
  }

  try {
    const { data, error } = await supabase.rpc("is_allowed_manual_source", {
      p_retailer_id: retailer.id,
      p_hostname: hostname,
      p_source_url: sourceUrl,
    });
    if (error) {
      console.error(`[admin-data] checkSaleSourceUrl failed: ${error.code ?? "unknown"}`);
      return "failed";
    }
    return data === true ? "allowed" : "rejected";
  } catch (checkError) {
    console.error(`[admin-data] checkSaleSourceUrl failed: ${checkError instanceof Error ? checkError.name : "UnknownError"}`);
    return "failed";
  }
}

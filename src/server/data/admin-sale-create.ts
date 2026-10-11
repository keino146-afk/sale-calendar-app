import "server-only";

import type { AdminSupabaseClient } from "@/server/supabase/admin-client";
import type { Database } from "@/server/supabase/database.types";
import type { SaleCandidateInput } from "@/lib/sale-candidate-form";
import { DataAccessError } from "./errors";

// Manual candidate creation for admins. The insert runs as the signed-in
// admin through RLS (sale_events_admin_insert) and the column-level INSERT
// grant, so only the 8 content columns can be written. status is never sent:
// the database default makes every new row pending_review, and triggers fill
// title_key / start_date_jst and write the "create" audit entry.

export type AdminRetailerOption = {
  id: string;
  slug: string;
  name: string;
  officialBaseUrl: string;
};

export type CreateResult = { ok: true; id: string } | { ok: false; reason: "duplicate" | "failed" };

const UNIQUE_VIOLATION = "23505";

type SaleEventInsert = Database["public"]["Tables"]["sale_events"]["Insert"];

// Exactly the columns granted to authenticated for INSERT.
type SaleCandidateRow = Pick<
  SaleEventInsert,
  "retailer_id" | "title" | "description" | "starts_at" | "ends_at" | "is_date_only" | "source_url" | "source_checked_at"
>;

type RetailerRow = { id: string; slug: string; name: string; official_base_url: string };

function toOption(row: RetailerRow): AdminRetailerOption {
  return { id: row.id, slug: row.slug, name: row.name, officialBaseUrl: row.official_base_url };
}

export async function listActiveRetailersForAdmin(
  supabase: AdminSupabaseClient,
): Promise<AdminRetailerOption[]> {
  const { data, error } = await supabase
    .from("retailers")
    .select("id, slug, name, official_base_url")
    .eq("is_active", true)
    .order("sort_order", { ascending: true })
    .order("slug", { ascending: true })
    .overrideTypes<RetailerRow[], { merge: false }>();

  if (error) {
    console.error(`[admin-data] listActiveRetailersForAdmin failed: ${error.code ?? "unknown"}`);
    throw new DataAccessError("Failed to load retailers");
  }
  return data.map(toOption);
}

// Re-reads the submitted retailer on the server; null when missing or inactive.
export async function getActiveRetailerForAdmin(
  supabase: AdminSupabaseClient,
  id: string,
): Promise<AdminRetailerOption | null> {
  const { data, error } = await supabase
    .from("retailers")
    .select("id, slug, name, official_base_url")
    .eq("id", id)
    .eq("is_active", true)
    .maybeSingle()
    .overrideTypes<RetailerRow | null, { merge: false }>();

  if (error) {
    console.error(`[admin-data] getActiveRetailerForAdmin failed: ${error.code ?? "unknown"}`);
    throw new DataAccessError("Failed to load retailer");
  }
  return data === null ? null : toOption(data);
}

export async function createSaleCandidate(
  supabase: AdminSupabaseClient,
  input: SaleCandidateInput,
): Promise<CreateResult> {
  const row: SaleCandidateRow = {
    retailer_id: input.retailerId,
    title: input.title,
    description: input.description,
    starts_at: input.startsAt.toISOString(),
    ends_at: input.endsAt.toISOString(),
    is_date_only: input.isDateOnly,
    source_url: input.sourceUrl,
    source_checked_at: input.sourceCheckedAt.toISOString(),
  };
  // The generated Insert type marks title_key / start_date_jst as required,
  // but a BEFORE INSERT trigger derives them (clients may not write them).
  const { data, error } = await supabase
    .from("sale_events")
    .insert(row as unknown as SaleEventInsert)
    .select("id")
    .single();

  if (error) {
    // Error code only: messages can include constraint names and values.
    console.error(`[admin-data] createSaleCandidate failed: ${error.code ?? "unknown"}`);
    return { ok: false, reason: error.code === UNIQUE_VIOLATION ? "duplicate" : "failed" };
  }
  return { ok: true, id: data.id };
}

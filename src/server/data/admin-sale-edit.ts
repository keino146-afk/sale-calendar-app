import "server-only";

import { adminReadSignal } from "./admin-read-timeout";
import type { AdminSupabaseClient } from "@/server/supabase/admin-client";
import { isAdminSaleStatus, type AdminSaleStatus } from "@/lib/admin-sale-status";
import type { SaleContentInput } from "@/lib/sale-candidate-form";
import { DataAccessError } from "./errors";
import { isSaleEventId } from "./admin-sale-events";

// Editing a registered sale's content. The read runs as the signed-in admin
// through RLS; the save is one call to public.update_sale_event, which checks
// the admin, locks the row, refuses archived or changed-since-loaded sales,
// requires confirmation for published ones and re-validates every value. The
// app never writes sale_events itself (and no longer has the privilege to).

export type EditableSaleDto = {
  id: string;
  status: AdminSaleStatus;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  isDateOnly: boolean;
  sourceUrl: string;
  sourceCheckedAt: string | null;
  // Exactly as the database returned it; sent back unchanged as the
  // expected version on save.
  updatedAt: string;
  retailer: { id: string; slug: string; name: string; officialBaseUrl: string };
};

type EditableSaleRow = {
  id: string;
  status: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  is_date_only: boolean;
  source_url: string;
  source_checked_at: string | null;
  updated_at: string;
  retailers: { id: string; slug: string; name: string; official_base_url: string } | null;
};

const EDITABLE_SALE_COLUMNS =
  "id, status, title, description, starts_at, ends_at, is_date_only, source_url, source_checked_at, updated_at, retailers!inner(id, slug, name, official_base_url)";

// Returns null for a malformed id (without querying) or a missing row.
export async function getAdminSaleEventForEdit(
  supabase: AdminSupabaseClient,
  id: string,
): Promise<EditableSaleDto | null> {
  if (!isSaleEventId(id)) return null;

  const { data, error } = await supabase
    .from("sale_events")
    .select(EDITABLE_SALE_COLUMNS)
    .eq("id", id)
    .abortSignal(adminReadSignal())
    .maybeSingle()
    .overrideTypes<EditableSaleRow | null, { merge: false }>();

  if (error || (data !== null && (data.retailers === null || !isAdminSaleStatus(data.status)))) {
    // Error code only: messages may contain upstream details.
    console.error(`[admin-data] getAdminSaleEventForEdit failed: ${error?.code ?? "unexpected_row"}`);
    throw new DataAccessError("Failed to load the sale for editing");
  }
  if (data === null || data.retailers === null || !isAdminSaleStatus(data.status)) return null;
  return {
    id: data.id,
    status: data.status,
    title: data.title,
    description: data.description,
    startsAt: data.starts_at,
    endsAt: data.ends_at,
    isDateOnly: data.is_date_only,
    sourceUrl: data.source_url,
    sourceCheckedAt: data.source_checked_at,
    updatedAt: data.updated_at,
    retailer: {
      id: data.retailers.id,
      slug: data.retailers.slug,
      name: data.retailers.name,
      officialBaseUrl: data.retailers.official_base_url,
    },
  };
}

export type UpdateSaleReason = "duplicate" | "stale" | "not_editable" | "not_found" | "invalid_input" | "failed";
export type UpdateSaleResult = { ok: true } | { ok: false; reason: UpdateSaleReason };

// Only these database codes are mapped; messages are never passed on.
const REASONS: Record<string, Exclude<UpdateSaleReason, "failed">> = {
  "23505": "duplicate",
  "40001": "stale",
  "55000": "not_editable",
  P0002: "not_found",
  "22023": "invalid_input",
};

export async function updateSaleEvent(
  supabase: AdminSupabaseClient,
  update: { id: string; expectedUpdatedAt: string; publishedConfirmed: boolean; content: SaleContentInput },
): Promise<UpdateSaleResult> {
  const { content } = update;
  try {
    const { error } = await supabase.rpc("update_sale_event", {
      p_id: update.id,
      p_expected_updated_at: update.expectedUpdatedAt,
      p_published_confirmed: update.publishedConfirmed,
      p_title: content.title,
      p_description: content.description,
      p_starts_at: content.startsAt.toISOString(),
      p_ends_at: content.endsAt.toISOString(),
      p_is_date_only: content.isDateOnly,
      p_source_url: content.sourceUrl,
      p_source_checked_at: content.sourceCheckedAt.toISOString(),
    });
    if (error) {
      console.error(`[admin-data] updateSaleEvent failed: ${error.code ?? "unknown"}`);
      const reason = error.code !== undefined && Object.hasOwn(REASONS, error.code) ? REASONS[error.code] : "failed";
      return { ok: false, reason };
    }
    return { ok: true };
  } catch (updateError) {
    console.error(
      `[admin-data] updateSaleEvent failed: ${updateError instanceof Error ? updateError.name : "UnknownError"}`,
    );
    return { ok: false, reason: "failed" };
  }
}

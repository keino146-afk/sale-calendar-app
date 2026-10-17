import "server-only";

import { adminReadSignal } from "./admin-read-timeout";
import type { AdminSupabaseClient } from "@/server/supabase/admin-client";
import { isAdminSaleStatus, type AdminSaleStatus } from "@/lib/admin-sale-status";
import { DataAccessError } from "./errors";

// Admin-only reads. Every function takes the client returned by
// requireAdmin(), so queries run as the signed-in admin through RLS
// (sale_events_admin_read / retailers_admin_read). Read only: nothing here
// writes, and no internal columns (title_key, start_date_jst, audit actors)
// are selected.

export type AdminSaleEventDto = {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  isDateOnly: boolean;
  status: AdminSaleStatus;
  sourceUrl: string;
  sourceCheckedAt: string | null;
  publishedAt: string | null;
  rejectedAt: string | null;
  archivedAt: string | null;
  retailer: { slug: string; name: string };
};

export const ADMIN_LIST_LIMIT = 100;

const ADMIN_SALE_EVENT_COLUMNS =
  "id, title, description, starts_at, ends_at, is_date_only, status, source_url, source_checked_at, published_at, rejected_at, archived_at, retailers!inner(slug, name)";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSaleEventId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

// Newest first by the timestamp that matches each status.
const ORDER_COLUMN: Record<AdminSaleStatus, "created_at" | "published_at" | "rejected_at" | "archived_at"> = {
  pending_review: "created_at",
  published: "published_at",
  rejected: "rejected_at",
  archived: "archived_at",
};

type AdminSaleEventRow = {
  id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  is_date_only: boolean;
  status: string;
  source_url: string;
  source_checked_at: string | null;
  published_at: string | null;
  rejected_at: string | null;
  archived_at: string | null;
  retailers: { slug: string; name: string } | null;
};

function fail(context: string, error: { code?: string } | null): never {
  // Error code only: messages may contain upstream details.
  console.error(`[admin-data] ${context} failed: ${error?.code ?? "unknown"}`);
  throw new DataAccessError("Failed to load admin sale events");
}

function toDto(row: AdminSaleEventRow, context: string): AdminSaleEventDto {
  if (row.retailers === null || !isAdminSaleStatus(row.status)) fail(context, { code: "unexpected_row" });
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isDateOnly: row.is_date_only,
    status: row.status,
    sourceUrl: row.source_url,
    sourceCheckedAt: row.source_checked_at,
    publishedAt: row.published_at,
    rejectedAt: row.rejected_at,
    archivedAt: row.archived_at,
    retailer: { slug: row.retailers.slug, name: row.retailers.name },
  };
}

export async function listAdminSaleEvents(
  supabase: AdminSupabaseClient,
  { status }: { status: AdminSaleStatus },
): Promise<AdminSaleEventDto[]> {
  const { data, error } = await supabase
    .from("sale_events")
    .select(ADMIN_SALE_EVENT_COLUMNS)
    .eq("status", status)
    .order(ORDER_COLUMN[status], { ascending: false })
    .order("id", { ascending: true })
    .limit(ADMIN_LIST_LIMIT)
    .abortSignal(adminReadSignal())
    .overrideTypes<AdminSaleEventRow[], { merge: false }>();

  if (error) fail("listAdminSaleEvents", error);
  return data.map((row) => toDto(row, "listAdminSaleEvents"));
}

export async function countPendingSaleEvents(supabase: AdminSupabaseClient): Promise<number> {
  const { count, error } = await supabase
    .from("sale_events")
    .select("id", { count: "exact", head: true })
    .eq("status", "pending_review")
    .abortSignal(adminReadSignal());

  if (error || count === null) fail("countPendingSaleEvents", error);
  return count;
}

// Returns null for a malformed id (without querying) or a missing row.
export async function getAdminSaleEvent(
  supabase: AdminSupabaseClient,
  id: string,
): Promise<AdminSaleEventDto | null> {
  if (!isSaleEventId(id)) return null;

  const { data, error } = await supabase
    .from("sale_events")
    .select(ADMIN_SALE_EVENT_COLUMNS)
    .eq("id", id)
    .abortSignal(adminReadSignal())
    .maybeSingle()
    .overrideTypes<AdminSaleEventRow | null, { merge: false }>();

  if (error) fail("getAdminSaleEvent", error);
  return data === null ? null : toDto(data, "getAdminSaleEvent");
}

// Reason text of the most recent reject audit entry. Only the note is
// selected: never the actor, row snapshots or other audit metadata.
export async function getLatestRejectReason(
  supabase: AdminSupabaseClient,
  id: string,
): Promise<string | null> {
  if (!isSaleEventId(id)) return null;

  const { data, error } = await supabase
    .from("sale_event_audit")
    .select("note")
    .eq("sale_event_id", id)
    .eq("action", "reject")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .abortSignal(adminReadSignal())
    .maybeSingle()
    .overrideTypes<{ note: string | null } | null, { merge: false }>();

  if (error) fail("getLatestRejectReason", error);
  return data?.note ?? null;
}

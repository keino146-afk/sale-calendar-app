import "server-only";

import { getPublicSupabaseClient } from "@/server/supabase/public-client";
import { DataAccessError, InvalidQueryError, logSupabaseError } from "./errors";

export type SaleEventDto = {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string;
  isDateOnly: boolean;
  sourceUrl: string;
  sourceCheckedAt: string | null;
  publishedAt: string;
  retailer: {
    slug: string;
    name: string;
  };
};

export type ListPublishedSaleEventsParams = {
  from: Date;
  to: Date;
  retailerSlug?: string;
};

// `retailers!inner` is intentional: retailers hidden by RLS (inactive) drop
// their published events from public results.
const SALE_EVENT_COLUMNS =
  "id, title, description, starts_at, ends_at, is_date_only, source_url, source_checked_at, published_at, retailers!inner(slug, name)";

const MAX_RANGE_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_RESULTS = 500;
const RETAILER_SLUG_PATTERN = /^[a-z0-9-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type SaleEventRow = {
  id: string;
  title: string;
  description: string | null;
  starts_at: string;
  ends_at: string;
  is_date_only: boolean;
  source_url: string;
  source_checked_at: string | null;
  published_at: string | null;
  retailers: { slug: string; name: string } | null;
};

function isValidDate(value: unknown): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function toDto(row: SaleEventRow, context: string): SaleEventDto {
  // published_at is guaranteed by a DB CHECK for published rows.
  if (row.published_at === null || row.retailers === null) {
    console.error(`[data] ${context}: unexpected null in published sale event`);
    throw new DataAccessError("Failed to load sale events");
  }
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isDateOnly: row.is_date_only,
    sourceUrl: row.source_url,
    sourceCheckedAt: row.source_checked_at,
    publishedAt: row.published_at,
    retailer: { slug: row.retailers.slug, name: row.retailers.name },
  };
}

// Returns published events overlapping [from, to): starts_at < to and ends_at > from.
export async function listPublishedSaleEvents({
  from,
  to,
  retailerSlug,
}: ListPublishedSaleEventsParams): Promise<SaleEventDto[]> {
  if (!isValidDate(from) || !isValidDate(to)) {
    throw new InvalidQueryError("Invalid date range");
  }
  if (from.getTime() >= to.getTime()) {
    throw new InvalidQueryError("Invalid date range");
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
    throw new InvalidQueryError("Date range is too long");
  }
  if (retailerSlug !== undefined && !RETAILER_SLUG_PATTERN.test(retailerSlug)) {
    throw new InvalidQueryError("Invalid retailer");
  }

  let query = getPublicSupabaseClient()
    .from("sale_events")
    .select(SALE_EVENT_COLUMNS)
    .eq("status", "published")
    .lt("starts_at", to.toISOString())
    .gt("ends_at", from.toISOString());

  if (retailerSlug !== undefined) {
    query = query.eq("retailers.slug", retailerSlug);
  }

  const { data, error } = await query
    .order("starts_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(MAX_RESULTS)
    .overrideTypes<SaleEventRow[], { merge: false }>();

  if (error) {
    logSupabaseError("listPublishedSaleEvents", error);
    throw new DataAccessError("Failed to load sale events");
  }

  return data.map((row) => toDto(row, "listPublishedSaleEvents"));
}

export async function getPublishedSaleEvent(id: string): Promise<SaleEventDto | null> {
  if (!UUID_PATTERN.test(id)) {
    return null;
  }

  const { data, error } = await getPublicSupabaseClient()
    .from("sale_events")
    .select(SALE_EVENT_COLUMNS)
    .eq("id", id)
    .eq("status", "published")
    .maybeSingle()
    .overrideTypes<SaleEventRow | null, { merge: false }>();

  if (error) {
    logSupabaseError("getPublishedSaleEvent", error);
    throw new DataAccessError("Failed to load sale event");
  }

  return data === null ? null : toDto(data, "getPublishedSaleEvent");
}

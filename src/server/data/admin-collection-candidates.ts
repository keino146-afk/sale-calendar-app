import "server-only";

import type { AdminSupabaseClient } from "@/server/supabase/admin-client";
import { DataAccessError } from "./errors";

// Admin-only, read-only access to collection candidates. Runs as the
// signed-in admin through RLS (collection_candidates_admin_read). Nothing
// here changes a candidate: importing is the atomic RPC in
// admin-candidate-import.ts.
// Hash columns are never selected; they are not needed for review.

export const CANDIDATE_REVIEW_STATES = ["new", "imported", "dismissed"] as const;
export type CandidateReviewState = (typeof CANDIDATE_REVIEW_STATES)[number];

export const CANDIDATE_LIST_LIMIT = 100;

export type CollectionCandidateSummary = {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string;
  isDateOnly: boolean;
  reviewState: CandidateReviewState;
  sourceChanged: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  retailer: { id: string; slug: string; name: string };
};

export type CollectionCandidateDetail = CollectionCandidateSummary & {
  description: string | null;
  sourceUrl: string;
  sourceCheckedAt: string;
  evidenceExcerpt: string;
  parserVersion: string;
  importedSaleEventId: string | null;
};

const SUMMARY_COLUMNS =
  "id, title, starts_at, ends_at, is_date_only, review_state, source_changed, first_seen_at, last_seen_at, retailers!inner(id, slug, name)";
const DETAIL_COLUMNS = `${SUMMARY_COLUMNS}, description, source_url, source_checked_at, evidence_excerpt, parser_version, imported_sale_event_id`;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCandidateId(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function parseCandidateReviewState(value: string | string[] | undefined): CandidateReviewState {
  return typeof value === "string" && (CANDIDATE_REVIEW_STATES as readonly string[]).includes(value)
    ? (value as CandidateReviewState)
    : "new";
}

type SummaryRow = {
  id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  is_date_only: boolean;
  review_state: string;
  source_changed: boolean;
  first_seen_at: string;
  last_seen_at: string;
  retailers: { id: string; slug: string; name: string } | null;
};

type DetailRow = SummaryRow & {
  description: string | null;
  source_url: string;
  source_checked_at: string;
  evidence_excerpt: string;
  parser_version: string;
  imported_sale_event_id: string | null;
};

function fail(context: string, error: { code?: string } | null): never {
  console.error(`[admin-data] ${context} failed: ${error?.code ?? "unknown"}`);
  throw new DataAccessError("Failed to load collection candidates");
}

function toSummary(row: SummaryRow, context: string): CollectionCandidateSummary {
  if (row.retailers === null || !(CANDIDATE_REVIEW_STATES as readonly string[]).includes(row.review_state)) {
    fail(context, { code: "unexpected_row" });
  }
  return {
    id: row.id,
    title: row.title,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    isDateOnly: row.is_date_only,
    reviewState: row.review_state as CandidateReviewState,
    sourceChanged: row.source_changed,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    retailer: { id: row.retailers.id, slug: row.retailers.slug, name: row.retailers.name },
  };
}

export async function listCollectionCandidates(
  supabase: AdminSupabaseClient,
  { reviewState }: { reviewState: CandidateReviewState },
): Promise<CollectionCandidateSummary[]> {
  const { data, error } = await supabase
    .from("collection_candidates")
    .select(SUMMARY_COLUMNS)
    .eq("review_state", reviewState)
    .order("last_seen_at", { ascending: false })
    .order("id", { ascending: true })
    .limit(CANDIDATE_LIST_LIMIT)
    .overrideTypes<SummaryRow[], { merge: false }>();

  if (error) fail("listCollectionCandidates", error);
  return data.map((row) => toSummary(row, "listCollectionCandidates"));
}

// Returns null for a malformed id (without querying) or a missing row.
export async function getCollectionCandidate(
  supabase: AdminSupabaseClient,
  id: string,
): Promise<CollectionCandidateDetail | null> {
  if (!isCandidateId(id)) return null;

  const { data, error } = await supabase
    .from("collection_candidates")
    .select(DETAIL_COLUMNS)
    .eq("id", id)
    .maybeSingle()
    .overrideTypes<DetailRow | null, { merge: false }>();

  if (error) fail("getCollectionCandidate", error);
  if (data === null) return null;
  return {
    ...toSummary(data, "getCollectionCandidate"),
    description: data.description,
    sourceUrl: data.source_url,
    sourceCheckedAt: data.source_checked_at,
    evidenceExcerpt: data.evidence_excerpt,
    parserVersion: data.parser_version,
    importedSaleEventId: isCandidateId(data.imported_sale_event_id) ? data.imported_sale_event_id : null,
  };
}

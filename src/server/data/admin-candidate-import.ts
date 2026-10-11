import "server-only";

import type { AdminSupabaseClient } from "@/server/supabase/admin-client";
import type { SaleCandidateInput } from "@/lib/sale-candidate-form";

// Creates a sale event from a collection candidate in one database call.
// public.import_collection_candidate locks the candidate, re-validates the
// admin's final values (retailer, title, period, source policy), inserts the
// pending_review sale and marks the candidate imported, all in one
// transaction: either everything happens or nothing does. The app never
// writes the candidate itself and makes no second call afterwards.

export type ImportResult =
  | { ok: true; id: string }
  | { ok: false; reason: "duplicate" | "candidate_state" | "invalid_input" | "failed" };

// Only these database codes are mapped; messages are never passed on.
const REASONS: Record<string, "duplicate" | "candidate_state" | "invalid_input"> = {
  "23505": "duplicate",
  P0002: "candidate_state",
  "55000": "candidate_state",
  "22023": "invalid_input",
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function importCollectionCandidate(
  supabase: AdminSupabaseClient,
  candidateId: string,
  input: SaleCandidateInput,
): Promise<ImportResult> {
  try {
    const { data, error } = await supabase.rpc("import_collection_candidate", {
      p_candidate_id: candidateId,
      p_retailer_id: input.retailerId,
      p_title: input.title,
      p_description: input.description,
      p_starts_at: input.startsAt.toISOString(),
      p_ends_at: input.endsAt.toISOString(),
      p_is_date_only: input.isDateOnly,
      p_source_url: input.sourceUrl,
      p_source_checked_at: input.sourceCheckedAt.toISOString(),
    });
    if (error) {
      console.error(`[admin-data] importCollectionCandidate failed: ${error.code ?? "unknown"}`);
      const reason = error.code !== undefined && Object.hasOwn(REASONS, error.code) ? REASONS[error.code] : "failed";
      return { ok: false, reason };
    }
    if (typeof data !== "string" || !UUID_PATTERN.test(data)) {
      console.error("[admin-data] importCollectionCandidate failed: unexpected_result");
      return { ok: false, reason: "failed" };
    }
    return { ok: true, id: data };
  } catch (importError) {
    console.error(
      `[admin-data] importCollectionCandidate failed: ${importError instanceof Error ? importError.name : "UnknownError"}`,
    );
    return { ok: false, reason: "failed" };
  }
}

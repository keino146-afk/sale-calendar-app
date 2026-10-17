import "server-only";

import type { AdminSupabaseClient } from "@/server/supabase/admin-client";

// Lifecycle changes go only through the existing SECURITY DEFINER RPCs,
// which re-check admin rights and the allowed transition themselves:
//   publish_sale_event   pending_review -> published
//   reject_sale_event    pending_review -> rejected (reason in audit note)
//   archive_sale_event   published      -> archived
//   reopen_sale_event    rejected       -> pending_review
// Nothing here updates sale_events directly.
//
// Every call sends p_expected_updated_at, the updated_at the admin's page was
// rendered with, which selects the stale-checking overload: under a row lock
// it refuses the transition if the sale changed since (P0409), so nobody
// publishes, rejects, archives or reopens content they have not seen. The
// value is passed on as the raw PostgREST string (microseconds intact).

export type LifecycleResult = { ok: true } | { ok: false; reason: "stale" | "failed" };

// P0409 is the stale code. 40001, the code the content-edit RPC used for
// staleness before Phase 6O, is read the same way for compatibility; no
// lifecycle RPC raises it.
const STALE_CODES = new Set(["P0409", "40001"]);

type RpcResult = { error: { code?: string } | null };

async function run(context: string, call: () => PromiseLike<RpcResult>): Promise<LifecycleResult> {
  try {
    const { error } = await call();
    if (!error) return { ok: true };
    // Error code only (e.g. P0409 stale, P0002 wrong state, 42501 not admin, 22023 bad input).
    console.error(`[admin-action] ${context} failed: ${error.code ?? "unknown"}`);
    if (error.code !== undefined && STALE_CODES.has(error.code)) return { ok: false, reason: "stale" };
  } catch (error) {
    console.error(`[admin-action] ${context} failed: ${error instanceof Error ? error.name : "UnknownError"}`);
  }
  return { ok: false, reason: "failed" };
}

export function publishSaleEvent(supabase: AdminSupabaseClient, id: string, expectedUpdatedAt: string) {
  return run("publish", () =>
    supabase.rpc("publish_sale_event", { p_id: id, p_expected_updated_at: expectedUpdatedAt }),
  );
}

export function rejectSaleEvent(supabase: AdminSupabaseClient, id: string, reason: string, expectedUpdatedAt: string) {
  return run("reject", () =>
    supabase.rpc("reject_sale_event", { p_id: id, p_reason: reason, p_expected_updated_at: expectedUpdatedAt }),
  );
}

export function archiveSaleEvent(supabase: AdminSupabaseClient, id: string, expectedUpdatedAt: string) {
  return run("archive", () =>
    supabase.rpc("archive_sale_event", { p_id: id, p_expected_updated_at: expectedUpdatedAt }),
  );
}

export function reopenSaleEvent(supabase: AdminSupabaseClient, id: string, expectedUpdatedAt: string) {
  return run("reopen", () =>
    supabase.rpc("reopen_sale_event", { p_id: id, p_expected_updated_at: expectedUpdatedAt }),
  );
}

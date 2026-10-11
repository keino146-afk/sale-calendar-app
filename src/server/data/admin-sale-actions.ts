import "server-only";

import type { AdminSupabaseClient } from "@/server/supabase/admin-client";

// Lifecycle changes go only through the existing SECURITY DEFINER RPCs,
// which re-check admin rights and the allowed transition themselves:
//   publish_sale_event   pending_review -> published
//   reject_sale_event    pending_review -> rejected (reason in audit note)
//   archive_sale_event   published      -> archived
//   reopen_sale_event    rejected       -> pending_review
// Nothing here updates sale_events directly.

export type LifecycleResult = { ok: true } | { ok: false };

type RpcResult = { error: { code?: string } | null };

async function run(context: string, call: () => PromiseLike<RpcResult>): Promise<LifecycleResult> {
  try {
    const { error } = await call();
    if (!error) return { ok: true };
    // Error code only (e.g. P0002 wrong state, 42501 not admin, 22023 bad reason).
    console.error(`[admin-action] ${context} failed: ${error.code ?? "unknown"}`);
  } catch (error) {
    console.error(`[admin-action] ${context} failed: ${error instanceof Error ? error.name : "UnknownError"}`);
  }
  return { ok: false };
}

export function publishSaleEvent(supabase: AdminSupabaseClient, id: string) {
  return run("publish", () => supabase.rpc("publish_sale_event", { p_id: id }));
}

export function rejectSaleEvent(supabase: AdminSupabaseClient, id: string, reason: string) {
  return run("reject", () => supabase.rpc("reject_sale_event", { p_id: id, p_reason: reason }));
}

export function archiveSaleEvent(supabase: AdminSupabaseClient, id: string) {
  return run("archive", () => supabase.rpc("archive_sale_event", { p_id: id }));
}

export function reopenSaleEvent(supabase: AdminSupabaseClient, id: string) {
  return run("reopen", () => supabase.rpc("reopen_sale_event", { p_id: id }));
}

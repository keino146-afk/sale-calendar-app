"use server";

import { redirect } from "next/navigation";
import { isSameOriginRequest } from "@/server/auth/admin-auth";
import { requireAdmin } from "@/server/auth/admin-session";
import {
  archiveSaleEvent,
  publishSaleEvent,
  rejectSaleEvent,
  reopenSaleEvent,
  type LifecycleResult,
} from "@/server/data/admin-sale-actions";
import { isSaleEventId } from "@/server/data/admin-sale-events";
import { normalizeRejectReason } from "@/lib/reject-reason";

// Each action re-checks everything itself (Server Actions are reachable by
// direct POST): same origin -> admin session -> sale id -> page version ->
// input -> RPC. redirect() throws, so it is never called inside try/catch.
//
// expectedUpdatedAt is the sale's updated_at as the page rendered it. It is
// only shape-checked here; the RPC compares it with the row under a lock,
// which is what actually refuses a transition on content the admin has not
// seen (stale -> the detail page reloads with the latest content).

type Done = "published" | "rejected" | "archived" | "reopened";

// A PostgREST timestamptz string, e.g. 2026-10-14T03:04:05.123456+00:00.
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

async function guard(
  formData: FormData,
): Promise<{ id: string; expectedUpdatedAt: string; supabase: Awaited<ReturnType<typeof requireAdmin>> }> {
  if (!(await isSameOriginRequest())) redirect("/admin");
  const supabase = await requireAdmin();
  const id = formData.get("saleId");
  if (!isSaleEventId(id)) redirect("/admin");
  const expectedUpdatedAt = formData.get("expectedUpdatedAt");
  if (typeof expectedUpdatedAt !== "string" || !TIMESTAMP_PATTERN.test(expectedUpdatedAt)) {
    redirect(`/admin/sales/${id}?error=1`);
  }
  return { id, expectedUpdatedAt, supabase };
}

function finish(id: string, result: LifecycleResult, done: Done): never {
  if (result.ok) redirect(`/admin/sales/${id}?done=${done}`);
  redirect(`/admin/sales/${id}?error=${result.reason === "stale" ? "stale" : "1"}`);
}

export async function publishSaleAction(formData: FormData): Promise<void> {
  const { id, expectedUpdatedAt, supabase } = await guard(formData);
  finish(id, await publishSaleEvent(supabase, id, expectedUpdatedAt), "published");
}

export async function archiveSaleAction(formData: FormData): Promise<void> {
  const { id, expectedUpdatedAt, supabase } = await guard(formData);
  finish(id, await archiveSaleEvent(supabase, id, expectedUpdatedAt), "archived");
}

export async function reopenSaleAction(formData: FormData): Promise<void> {
  const { id, expectedUpdatedAt, supabase } = await guard(formData);
  finish(id, await reopenSaleEvent(supabase, id, expectedUpdatedAt), "reopened");
}

export async function rejectSaleAction(formData: FormData): Promise<void> {
  const { id, expectedUpdatedAt, supabase } = await guard(formData);
  const reason = normalizeRejectReason(formData.get("reason"));
  if (reason === null) redirect(`/admin/sales/${id}/reject?error=reason`);
  finish(id, await rejectSaleEvent(supabase, id, reason, expectedUpdatedAt), "rejected");
}

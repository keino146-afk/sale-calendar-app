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
// direct POST): same origin -> admin session -> sale id -> input -> RPC.
// redirect() throws, so it is never called inside try/catch.

type Done = "published" | "rejected" | "archived" | "reopened";

async function guard(formData: FormData): Promise<{ id: string; supabase: Awaited<ReturnType<typeof requireAdmin>> }> {
  if (!(await isSameOriginRequest())) redirect("/admin");
  const supabase = await requireAdmin();
  const id = formData.get("saleId");
  if (!isSaleEventId(id)) redirect("/admin");
  return { id, supabase };
}

function finish(id: string, result: LifecycleResult, done: Done): never {
  redirect(result.ok ? `/admin/sales/${id}?done=${done}` : `/admin/sales/${id}?error=1`);
}

export async function publishSaleAction(formData: FormData): Promise<void> {
  const { id, supabase } = await guard(formData);
  finish(id, await publishSaleEvent(supabase, id), "published");
}

export async function archiveSaleAction(formData: FormData): Promise<void> {
  const { id, supabase } = await guard(formData);
  finish(id, await archiveSaleEvent(supabase, id), "archived");
}

export async function reopenSaleAction(formData: FormData): Promise<void> {
  const { id, supabase } = await guard(formData);
  finish(id, await reopenSaleEvent(supabase, id), "reopened");
}

export async function rejectSaleAction(formData: FormData): Promise<void> {
  const { id, supabase } = await guard(formData);
  const reason = normalizeRejectReason(formData.get("reason"));
  if (reason === null) redirect(`/admin/sales/${id}/reject?error=reason`);
  finish(id, await rejectSaleEvent(supabase, id, reason), "rejected");
}

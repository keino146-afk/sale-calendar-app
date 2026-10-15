"use server";

import { redirect } from "next/navigation";
import { isSameOriginRequest } from "@/server/auth/admin-auth";
import { requireAdmin } from "@/server/auth/admin-session";
import { isSaleEventId } from "@/server/data/admin-sale-events";
import { getAdminSaleEventForEdit, updateSaleEvent } from "@/server/data/admin-sale-edit";
import { checkSaleSourceUrl } from "@/server/data/admin-source-policy";
import { isEditableSaleStatus } from "@/lib/admin-sale-status";
import { parsePeriodMode, parseSaleContentForm } from "@/lib/sale-candidate-form";

// Order: same origin -> admin session -> sale id -> current sale (as the
// admin) -> editable status -> unchanged since loaded -> published
// confirmation -> parse/validate -> newer check time for a new source URL ->
// source URL policy -> update RPC (which re-checks all of it) -> redirect.
// The retailer and status are never taken from the form. redirect() throws,
// so it is never called inside try/catch. Only fixed error codes go into the
// URL; no user input or database detail does.

export async function updateSaleAction(formData: FormData): Promise<void> {
  if (!(await isSameOriginRequest())) redirect("/admin");
  const supabase = await requireAdmin();

  const id = formData.get("saleId");
  if (!isSaleEventId(id)) redirect("/admin");
  const rawMode = formData.get("mode");
  const mode = parsePeriodMode(typeof rawMode === "string" ? rawMode : undefined);
  const back = (error: string) => `/admin/sales/${id}/edit?mode=${mode}&error=${error}`;

  let sale;
  try {
    sale = await getAdminSaleEventForEdit(supabase, id);
  } catch {
    sale = undefined;
  }
  if (sale === undefined) redirect(back("failed"));
  if (sale === null) redirect(back("not_found"));
  if (!isEditableSaleStatus(sale.status)) redirect(back("not_editable"));

  // The version the form was loaded with; the database checks it again
  // under a row lock.
  const expectedUpdatedAt = formData.get("expectedUpdatedAt");
  if (typeof expectedUpdatedAt !== "string" || expectedUpdatedAt !== sale.updatedAt) redirect(back("stale"));

  const publishedConfirmed = formData.get("confirmPublished") === "on";
  if (sale.status === "published" && !publishedConfirmed) redirect(back("confirm_published"));

  const parsed = parseSaleContentForm(formData, mode);
  if (!parsed.ok) redirect(back(parsed.error));
  const content = parsed.value;

  if (
    content.sourceUrl !== sale.sourceUrl &&
    sale.sourceCheckedAt !== null &&
    content.sourceCheckedAt.getTime() <= new Date(sale.sourceCheckedAt).getTime()
  ) {
    redirect(back("checked_at_not_newer"));
  }

  const sourceCheck = await checkSaleSourceUrl(
    supabase,
    { id: sale.retailer.id, officialBaseUrl: sale.retailer.officialBaseUrl },
    content.sourceUrl,
  );
  if (sourceCheck === "failed") redirect(back("failed"));
  if (sourceCheck !== "allowed") redirect(back("source_domain"));

  const result = await updateSaleEvent(supabase, { id, expectedUpdatedAt, publishedConfirmed, content });
  if (!result.ok) redirect(back(result.reason));
  redirect(`/admin/sales/${id}?done=updated`);
}

"use server";

import { redirect } from "next/navigation";
import { isSameOriginRequest } from "@/server/auth/admin-auth";
import { requireAdmin } from "@/server/auth/admin-session";
import { createSaleCandidate, getActiveRetailerForAdmin } from "@/server/data/admin-sale-create";
import { isCandidateId } from "@/server/data/admin-collection-candidates";
import { checkSaleSourceUrl } from "@/server/data/admin-source-policy";
import { parsePeriodMode, parseSaleCandidateForm } from "@/lib/sale-candidate-form";

// Order: same origin -> admin session -> parse/validate -> active retailer
// check (server-side) -> source URL policy -> insert -> redirect. redirect()
// throws, so it is never called inside try/catch. Only fixed error codes go
// into the URL; no user input or database detail does.

export async function createSaleCandidateAction(formData: FormData): Promise<void> {
  if (!(await isSameOriginRequest())) redirect("/admin");
  const supabase = await requireAdmin();

  const rawMode = formData.get("mode");
  const mode = parsePeriodMode(typeof rawMode === "string" ? rawMode : undefined);
  // A prefilled form keeps its candidate on error; only a validated UUID goes
  // into the URL. The candidate itself is never changed here.
  const rawCandidateId = formData.get("candidateId");
  const candidateQuery = isCandidateId(rawCandidateId) ? `&candidateId=${rawCandidateId}` : "";
  const back = (error: string) => `/admin/new?mode=${mode}${candidateQuery}&error=${error}`;

  const parsed = parseSaleCandidateForm(formData, mode);
  if (!parsed.ok) redirect(back(parsed.error));
  const input = parsed.value;

  let retailer;
  try {
    retailer = await getActiveRetailerForAdmin(supabase, input.retailerId);
  } catch {
    retailer = undefined;
  }
  if (retailer === undefined) redirect(back("failed"));
  if (retailer === null) redirect(back("retailer"));
  // The retailer's official domain or an approved official announcement
  // source; prefilled values get no shortcut.
  const sourceCheck = await checkSaleSourceUrl(supabase, retailer, input.sourceUrl);
  if (sourceCheck === "failed") redirect(back("failed"));
  if (sourceCheck !== "allowed") redirect(back("source_domain"));

  const result = await createSaleCandidate(supabase, input);
  if (!result.ok) redirect(back(result.reason));
  redirect(`/admin/sales/${result.id}?done=created`);
}

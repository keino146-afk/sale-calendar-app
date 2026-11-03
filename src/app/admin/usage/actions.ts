"use server";

import { redirect } from "next/navigation";
import { clearP6Draft, p6DraftDigest, readP6Draft, saveP6Draft } from "./draft-cookie";
import { isSameOriginRequest } from "@/server/auth/admin-auth";
import { requireAdmin } from "@/server/auth/admin-session";
import {
  recordP6MonitoringFailure,
  recordP6UsageCheck,
  resumeP6,
  stopP6,
  voidP6UsageCheck,
} from "@/server/data/admin-usage-monitoring";
import {
  P6_FAILURE_KIND_LABELS,
  P6_STOP_REASON_CHOICES,
  P6_VOID_REASON_LABELS,
  parseP6UsageForm,
  pickP6RawForm,
} from "@/lib/p6-usage-form";

// Each action: same origin -> admin session -> its own checks -> one RPC
// (which checks admin rights and everything else again) -> redirect.
// redirect() throws, so it is never called inside try/catch. Only fixed
// codes go into the URL, never the numbers entered.

const PAGE = "/admin/usage";
const VERSION = /^\d{1,15}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;

function parseVersion(value: FormDataEntryValue | null): number | null {
  return typeof value === "string" && VERSION.test(value) ? Number(value) : null;
}

function confirmed(formData: FormData): boolean {
  return formData.get("confirmed") === "on";
}

// Step 1: keep the form (cookie) and show it for confirmation. Nothing is
// stored in the database here.
export async function previewUsageAction(formData: FormData): Promise<void> {
  if (!(await isSameOriginRequest())) redirect(PAGE);
  await requireAdmin();

  const raw = pickP6RawForm((name) => formData.get(name));
  // Too large to keep: the old draft is gone too, and there is nothing to
  // confirm.
  if (!(await saveP6Draft(raw))) redirect(`${PAGE}?error=draft_too_large#input`);
  const parsed = parseP6UsageForm(raw);
  if (!parsed.ok) redirect(`${PAGE}?error=${parsed.error}#input`);
  redirect(`${PAGE}?step=confirm#confirm`);
}

// Step 2: store what was confirmed, if the draft is still the one shown
// (its digest), and the page version and the shown validity still hold
// (the database checks both under its lock).
export async function commitUsageAction(formData: FormData): Promise<void> {
  if (!(await isSameOriginRequest())) redirect(PAGE);
  const supabase = await requireAdmin();

  if (!confirmed(formData)) redirect(`${PAGE}?step=confirm&error=confirm_required#confirm`);
  const version = parseVersion(formData.get("expectedVersion"));
  const valid = formData.get("expectedValid");
  if (version === null || (valid !== "true" && valid !== "false")) redirect(`${PAGE}?step=confirm&error=stale#confirm`);
  const digest = formData.get("draftDigest");

  const raw = await readP6Draft();
  if (raw === null) redirect(`${PAGE}?error=draft_missing#input`);
  // Changed since it was shown (e.g. confirmed again in another tab): show
  // the current draft for a new confirmation instead of storing it.
  if (typeof digest !== "string" || !DIGEST.test(digest) || digest !== p6DraftDigest(raw)) {
    redirect(`${PAGE}?step=confirm&error=draft_changed#confirm`);
  }
  const parsed = parseP6UsageForm(raw);
  if (!parsed.ok) redirect(`${PAGE}?error=${parsed.error}#input`);

  const result = await recordP6UsageCheck(supabase, parsed.value, { version, valid: valid === "true" });
  if (!result.ok) {
    redirect(result.reason === "stale" ? `${PAGE}?step=confirm&error=stale#confirm` : `${PAGE}?error=${result.reason}#input`);
  }
  await clearP6Draft();
  redirect(`${PAGE}?done=${result.valid ? "recorded" : "recorded_invalid"}`);
}

export async function discardDraftAction(): Promise<void> {
  if (!(await isSameOriginRequest())) redirect(PAGE);
  await requireAdmin();

  await clearP6Draft();
  redirect(`${PAGE}?done=discarded`);
}

export async function failureAction(formData: FormData): Promise<void> {
  if (!(await isSameOriginRequest())) redirect(PAGE);
  const supabase = await requireAdmin();

  const kind = formData.get("kind");
  if (typeof kind !== "string" || !Object.hasOwn(P6_FAILURE_KIND_LABELS, kind)) redirect(`${PAGE}?error=invalid_input#failure`);
  if (!confirmed(formData)) redirect(`${PAGE}?error=confirm_required#failure`);

  const result = await recordP6MonitoringFailure(supabase, kind);
  redirect(result.ok ? `${PAGE}?done=failure_recorded` : `${PAGE}?error=${result.reason}#failure`);
}

export async function stopAction(formData: FormData): Promise<void> {
  if (!(await isSameOriginRequest())) redirect(PAGE);
  const supabase = await requireAdmin();

  const reason = formData.get("reason");
  if (typeof reason !== "string" || !Object.hasOwn(P6_STOP_REASON_CHOICES, reason)) redirect(`${PAGE}?error=invalid_input#stop`);
  if (!confirmed(formData)) redirect(`${PAGE}?error=confirm_required#stop`);

  const result = await stopP6(supabase, reason);
  redirect(result.ok ? `${PAGE}?done=stopped` : `${PAGE}?error=${result.reason}#stop`);
}

export async function resumeAction(formData: FormData): Promise<void> {
  if (!(await isSameOriginRequest())) redirect(PAGE);
  const supabase = await requireAdmin();

  const target = formData.get("target");
  if (target !== "registration" && target !== "send") redirect(`${PAGE}?error=invalid_input#resume`);
  const version = parseVersion(formData.get("expectedVersion"));
  if (version === null) redirect(`${PAGE}?error=stale#resume`);
  if (!confirmed(formData)) redirect(`${PAGE}?error=confirm_required#resume`);

  const result = await resumeP6(supabase, { target, expectedVersion: version });
  if (result.ok) redirect(`${PAGE}?done=resumed_${target}`);
  if (result.reason.startsWith("refused:")) {
    redirect(`${PAGE}?error=resume_refused&refusal=${result.reason.slice("refused:".length)}#resume`);
  }
  redirect(`${PAGE}?error=${result.reason}#resume`);
}

export async function voidAction(formData: FormData): Promise<void> {
  if (!(await isSameOriginRequest())) redirect(PAGE);
  const supabase = await requireAdmin();

  const checkId = formData.get("checkId");
  const reason = formData.get("reason");
  if (typeof checkId !== "string" || !UUID.test(checkId)) redirect(`${PAGE}?error=invalid_input#history`);
  if (typeof reason !== "string" || !Object.hasOwn(P6_VOID_REASON_LABELS, reason)) redirect(`${PAGE}?error=invalid_input#history`);
  const version = parseVersion(formData.get("expectedVersion"));
  if (version === null) redirect(`${PAGE}?error=stale#history`);
  if (!confirmed(formData)) redirect(`${PAGE}?error=confirm_required#history`);

  const result = await voidP6UsageCheck(supabase, { checkId, reason, expectedVersion: version });
  redirect(result.ok ? `${PAGE}?done=voided` : `${PAGE}?error=${result.reason}#history`);
}

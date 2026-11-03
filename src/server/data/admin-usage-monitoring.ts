import "server-only";

import { DataAccessError } from "./errors";
import type { P6UsageCheckDraft } from "@/lib/p6-usage-form";
import type { AdminSupabaseClient } from "@/server/supabase/admin-client";
import type { Json } from "@/server/supabase/database.types";

// P6 usage monitoring goes only through the admin RPCs of
// 20261102120000_p6_usage_monitoring.sql, which check admin rights first
// and keep every table private:
//   admin_get_p6_status                 everything the usage page shows
//   admin_record_p6_usage_check         validate (p_commit false) or store a check
//   admin_void_p6_usage_check           void a check (it is kept)
//   admin_record_p6_monitoring_failure  record a monitoring failure
//   admin_stop_p6                       manual stop
//   admin_resume_p6                     resume registrations or sending
// The state these produce is not connected to push registration or sending
// yet (both gates stay closed in the database).
//
// Only error codes are logged. Results are parsed defensively: anything
// unexpected is a failure, never a default.

type JsonObject = { [key: string]: Json | undefined };

function obj(value: Json | undefined): JsonObject | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
}
function arr(value: Json | undefined): Json[] | null {
  return Array.isArray(value) ? value : null;
}
function str(value: Json | undefined): string | null {
  return typeof value === "string" ? value : null;
}
function bool(value: Json | undefined): boolean | null {
  return typeof value === "boolean" ? value : null;
}
function int(value: Json | undefined): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}
// A timestamp the page can show, or null (none, or -infinity / infinity).
function time(value: Json | undefined): string | null {
  const text = str(value);
  return text !== null && Number.isFinite(Date.parse(text)) ? text : null;
}
function strings(value: Json | undefined): string[] | null {
  const list = arr(value);
  if (list === null) return null;
  const out = list.map(str);
  return out.every((item): item is string => item !== null) ? out : null;
}

export type P6State = {
  evaluatedAt: string;
  registrationAllowed: boolean;
  tokenChangeAllowed: boolean;
  sendsAllowed: boolean;
  sendInGrace: boolean;
  registrationStopAt: string | null;
  registrationStopReason: string | null;
  sendStopAt: string | null;
  sendStopReason: string | null;
  monitoringIncidentAt: string | null;
  sendGraceUntil: string | null;
  registrationResumedAt: string | null;
  sendResumedAt: string | null;
  currentCheckId: string | null;
  registrationDeadline: string | null;
  sendDeadline: string | null;
  currentMaxLevel: number | null;
  manualStopActive: boolean;
  version: number;
};

export type P6Value = {
  metric: string;
  status: "measured" | "unavailable";
  enteredValue: string | null;
  enteredUnit: string | null;
  usage: string | null;
  percent: string | null;
  level: number | null;
};

export type P6Check = {
  id: string;
  checkedAt: string;
  recordedAt: string;
  periodStart: string;
  periodEnd: string;
  spendCap: string;
  dataAsOf: string | null;
  isValid: boolean;
  invalidReasons: string[];
  voidedReason: string | null;
  voidedAt: string | null;
  values: P6Value[];
};

export type P6Status = {
  state: P6State;
  resumeRegistrationRefusal: string | null;
  resumeSendRefusal: string | null;
  checks: P6Check[];
  failures: { id: string; kind: string; recordedAt: string }[];
  manualStops: { id: string; reason: string; stoppedAt: string }[];
  warnings: { id: string; createdAt: string; kind: string; level: number | null; metric: string | null; periodStart: string | null }[];
};

function parseState(value: Json | undefined): P6State | null {
  const s = obj(value);
  if (s === null) return null;
  const evaluatedAt = time(s.evaluated_at);
  const flags = [s.registration_allowed, s.token_change_allowed, s.sends_allowed, s.send_in_grace, s.manual_stop_active].map(bool);
  const version = int(s.version);
  if (evaluatedAt === null || version === null || flags.some((flag) => flag === null)) return null;
  const [registrationAllowed, tokenChangeAllowed, sendsAllowed, sendInGrace, manualStopActive] = flags as boolean[];
  return {
    evaluatedAt,
    registrationAllowed,
    tokenChangeAllowed,
    sendsAllowed,
    sendInGrace,
    registrationStopAt: time(s.registration_stop_at),
    registrationStopReason: str(s.registration_stop_reason),
    sendStopAt: time(s.send_stop_at),
    sendStopReason: str(s.send_stop_reason),
    monitoringIncidentAt: time(s.monitoring_incident_at),
    sendGraceUntil: time(s.send_grace_until),
    registrationResumedAt: time(s.registration_resumed_at),
    sendResumedAt: time(s.send_resumed_at),
    currentCheckId: str(s.current_check_id),
    registrationDeadline: time(s.current_check_registration_deadline),
    sendDeadline: time(s.current_check_send_deadline),
    currentMaxLevel: int(s.current_max_level),
    manualStopActive,
    version,
  };
}

function parseValue(value: Json): P6Value | null {
  const v = obj(value);
  const metric = str(v?.metric);
  const status = str(v?.status);
  if (v === null || metric === null || (status !== "measured" && status !== "unavailable")) return null;
  return {
    metric,
    status,
    enteredValue: str(v.entered_value),
    enteredUnit: str(v.entered_unit),
    usage: str(v.usage),
    percent: str(v.percent),
    level: int(v.level),
  };
}

function parseCheck(value: Json): P6Check | null {
  const c = obj(value);
  if (c === null) return null;
  const id = str(c.id);
  const checkedAt = time(c.checked_at);
  const recordedAt = time(c.recorded_at);
  const periodStart = str(c.period_start);
  const periodEnd = str(c.period_end);
  const spendCap = str(c.spend_cap);
  const isValid = bool(c.is_valid);
  const invalidReasons = strings(c.invalid_reasons);
  const values = arr(c.values)?.map(parseValue) ?? null;
  if (
    id === null || checkedAt === null || recordedAt === null || periodStart === null || periodEnd === null ||
    spendCap === null || isValid === null || invalidReasons === null || values === null || values.some((item) => item === null)
  ) {
    return null;
  }
  return {
    id,
    checkedAt,
    recordedAt,
    periodStart,
    periodEnd,
    spendCap,
    dataAsOf: time(c.data_as_of),
    isValid,
    invalidReasons,
    voidedReason: str(c.voided_reason),
    voidedAt: time(c.voided_at),
    values: values as P6Value[],
  };
}

function parseList<T>(value: Json | undefined, parse: (item: Json) => T | null): T[] | null {
  const list = arr(value)?.map(parse) ?? null;
  return list !== null && list.every((item) => item !== null) ? (list as T[]) : null;
}

export function parseP6Status(value: Json): P6Status | null {
  const root = obj(value);
  if (root === null) return null;
  const state = parseState(root.state);
  const checks = parseList(root.checks, parseCheck);
  const failures = parseList(root.failures, (item) => {
    const f = obj(item);
    const id = str(f?.id);
    const kind = str(f?.kind);
    const recordedAt = time(f?.recorded_at);
    return id !== null && kind !== null && recordedAt !== null ? { id, kind, recordedAt } : null;
  });
  const manualStops = parseList(root.manual_stops, (item) => {
    const s = obj(item);
    const id = str(s?.id);
    const reason = str(s?.reason);
    const stoppedAt = time(s?.stopped_at);
    return id !== null && reason !== null && stoppedAt !== null ? { id, reason, stoppedAt } : null;
  });
  const warnings = parseList(root.warnings, (item) => {
    const w = obj(item);
    const id = str(w?.id);
    const createdAt = time(w?.created_at);
    const kind = str(w?.kind);
    return id !== null && createdAt !== null && kind !== null
      ? { id, createdAt, kind, level: int(w?.level), metric: str(w?.metric), periodStart: str(w?.period_start) }
      : null;
  });
  if (state === null || checks === null || failures === null || manualStops === null || warnings === null) return null;
  return {
    state,
    resumeRegistrationRefusal: str(root.resume_registration_refusal),
    resumeSendRefusal: str(root.resume_send_refusal),
    checks,
    failures,
    manualStops,
    warnings,
  };
}

export async function getP6Status(supabase: AdminSupabaseClient): Promise<P6Status> {
  const { data, error } = await supabase.rpc("admin_get_p6_status");
  if (error) {
    console.error(`[admin-usage] status failed: ${error.code ?? "unknown"}`);
    throw new DataAccessError("Failed to load usage monitoring status");
  }
  const status = parseP6Status(data);
  if (status === null) {
    console.error("[admin-usage] status failed: unexpected result");
    throw new DataAccessError("Failed to load usage monitoring status");
  }
  return status;
}

export type P6Preview = {
  valid: boolean;
  reasons: string[];
  values: (P6Value & { quota: string | null; enteredQuota: string | null })[];
  evaluatedAt: string;
  version: number;
};

export type P6WriteFailure = "stale" | "duplicate" | "invalid_input" | "not_found" | "failed";

const ERROR_REASONS: Record<string, P6WriteFailure> = {
  P0409: "stale",
  "23505": "duplicate",
  "22023": "invalid_input",
  P0002: "not_found",
};

type RpcResult = { data?: unknown; error: { code?: string } | null };

async function call(
  context: string,
  rpc: () => PromiseLike<RpcResult>,
): Promise<{ ok: true; data: Json } | { ok: false; reason: P6WriteFailure }> {
  try {
    const { data, error } = await rpc();
    if (!error) return { ok: true, data: (data ?? null) as Json };
    // Error code only (42501 not admin, 22023 bad input, P0409 stale, ...).
    console.error(`[admin-usage] ${context} failed: ${error.code ?? "unknown"}`);
    return { ok: false, reason: (error.code !== undefined && ERROR_REASONS[error.code]) || "failed" };
  } catch (error) {
    console.error(`[admin-usage] ${context} failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    return { ok: false, reason: "failed" };
  }
}

function checkArgs(draft: P6UsageCheckDraft) {
  return {
    p_checked_at: draft.checkedAt.toISOString(),
    p_period_start: draft.periodStart,
    p_period_end: draft.periodEnd,
    p_spend_cap: draft.spendCap,
    p_data_as_of: draft.dataAsOf === null ? null : draft.dataAsOf.toISOString(),
    p_values: draft.values,
  };
}

function parsePreview(value: Json): P6Preview | null {
  const p = obj(value);
  if (p === null) return null;
  const valid = bool(p.valid);
  const reasons = strings(p.reasons);
  const evaluatedAt = time(p.evaluated_at);
  const version = int(p.version);
  const values = parseList(p.values, (item) => {
    const base = parseValue(item);
    const v = obj(item);
    return base === null ? null : { ...base, quota: str(v?.quota), enteredQuota: str(v?.entered_quota) };
  });
  if (valid === null || reasons === null || evaluatedAt === null || version === null || values === null) return null;
  return { valid, reasons, values, evaluatedAt, version };
}

// Validates the check in the database without storing anything.
export async function previewP6UsageCheck(
  supabase: AdminSupabaseClient,
  draft: P6UsageCheckDraft,
): Promise<{ ok: true; preview: P6Preview } | { ok: false; reason: P6WriteFailure }> {
  const result = await call("preview", () =>
    supabase.rpc("admin_record_p6_usage_check", {
      ...checkArgs(draft),
      p_commit: false,
      p_expected_version: null,
      p_expected_valid: null,
    }),
  );
  if (!result.ok) return result;
  const preview = parsePreview(result.data);
  return preview === null ? { ok: false, reason: "failed" } : { ok: true, preview };
}

// Stores the check if the version and its validity are still those the
// admin confirmed (otherwise stale, nothing stored).
export async function recordP6UsageCheck(
  supabase: AdminSupabaseClient,
  draft: P6UsageCheckDraft,
  expected: { version: number; valid: boolean },
): Promise<{ ok: true; valid: boolean } | { ok: false; reason: P6WriteFailure }> {
  const result = await call("record", () =>
    supabase.rpc("admin_record_p6_usage_check", {
      ...checkArgs(draft),
      p_commit: true,
      p_expected_version: expected.version,
      p_expected_valid: expected.valid,
    }),
  );
  if (!result.ok) return result;
  const stored = obj(result.data);
  const valid = bool(stored?.valid);
  return bool(stored?.committed) === true && valid !== null ? { ok: true, valid } : { ok: false, reason: "failed" };
}

export async function voidP6UsageCheck(
  supabase: AdminSupabaseClient,
  input: { checkId: string; reason: string; expectedVersion: number },
): Promise<{ ok: true } | { ok: false; reason: P6WriteFailure }> {
  const result = await call("void", () =>
    supabase.rpc("admin_void_p6_usage_check", {
      p_check_id: input.checkId,
      p_reason: input.reason,
      p_expected_version: input.expectedVersion,
    }),
  );
  return result.ok ? { ok: true } : result;
}

export async function recordP6MonitoringFailure(
  supabase: AdminSupabaseClient,
  kind: string,
): Promise<{ ok: true } | { ok: false; reason: P6WriteFailure }> {
  const result = await call("failure", () => supabase.rpc("admin_record_p6_monitoring_failure", { p_kind: kind }));
  return result.ok ? { ok: true } : result;
}

export async function stopP6(
  supabase: AdminSupabaseClient,
  reason: string,
): Promise<{ ok: true } | { ok: false; reason: P6WriteFailure }> {
  const result = await call("stop", () => supabase.rpc("admin_stop_p6", { p_reason: reason }));
  return result.ok ? { ok: true } : result;
}

// A refused resume returns the database's refusal code.
export async function resumeP6(
  supabase: AdminSupabaseClient,
  input: { target: "registration" | "send"; expectedVersion: number },
): Promise<{ ok: true } | { ok: false; reason: P6WriteFailure | `refused:${string}` }> {
  const result = await call("resume", () =>
    supabase.rpc("admin_resume_p6", { p_target: input.target, p_expected_version: input.expectedVersion }),
  );
  if (!result.ok) return result;
  const answer = obj(result.data);
  if (bool(answer?.ok) === true) return { ok: true };
  const refusal = str(answer?.reason);
  return { ok: false, reason: refusal !== null && /^[a-z_]{1,64}$/.test(refusal) ? `refused:${refusal}` : "failed" };
}

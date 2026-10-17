import "server-only";

import { isAuthRetryableFetchError } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import {
  createAdminSupabaseClient,
  type AdminSupabaseClient,
} from "@/server/supabase/admin-client";

export const ADMIN_HOME_PATH = "/admin";
export const ADMIN_LOGIN_PATH = "/admin/login";
// The same generic failure is used for wrong credentials and non-admin
// accounts, so the login page never reveals which one happened.
export const ADMIN_LOGIN_FAILED_PATH = "/admin/login?error=1";
// Shown when the session or the admin check could not be verified because of
// a temporary backend failure. Access is still refused, but the session is
// kept so a reload can succeed once the backend is back.
export const ADMIN_UNAVAILABLE_PATH = "/admin/unavailable";

// Result of the database admin check. check_failed means "could not tell",
// never "allowed".
export type AdminAuthorization = "authorized" | "not_authorized" | "check_failed";

type AdminCheck =
  | { kind: "admin"; supabase: AdminSupabaseClient }
  | { kind: "anonymous" }
  | { kind: "denied"; supabase: AdminSupabaseClient }
  | { kind: "unavailable" };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

// Asks the database whether the signed-in user is an admin. Only a plain
// boolean without an error is an answer; an error or any other value is
// check_failed (fail closed: never treated as authorized).
export async function checkCurrentUserAdmin(supabase: AdminSupabaseClient): Promise<AdminAuthorization> {
  const { data, error } = await supabase.rpc("current_user_is_admin");
  if (error) {
    console.error(`[admin] admin check failed: ${error.code ?? "unknown"}`);
    return "check_failed";
  }
  if (data === true) return "authorized";
  if (data === false) return "not_authorized";
  console.error("[admin] admin check failed: unexpected_result");
  return "check_failed";
}

async function signOutWithScope(supabase: AdminSupabaseClient, scope: "global" | "local"): Promise<void> {
  try {
    const { error } = await supabase.auth.signOut({ scope });
    if (error) console.error(`[admin] sign-out failed: ${error.name}`);
  } catch (error) {
    console.error(`[admin] sign-out failed: ${errorName(error)}`);
  }
}

// Global sign-out (all of this account's sessions). Failures are logged by
// name only; callers always continue to the login page.
export async function signOutGlobally(supabase: AdminSupabaseClient): Promise<void> {
  await signOutWithScope(supabase, "global");
}

// Ends only this session (other devices are untouched). Same logging.
export async function signOutLocally(supabase: AdminSupabaseClient): Promise<void> {
  await signOutWithScope(supabase, "local");
}

async function checkAdmin(): Promise<AdminCheck> {
  let supabase: AdminSupabaseClient;
  try {
    supabase = await createAdminSupabaseClient();
  } catch (error) {
    console.error(`[admin] auth unavailable: ${errorName(error)}`);
    return { kind: "anonymous" };
  }

  // getUser() verifies the session with Supabase Auth on every call, so a
  // revoked or expired session is rejected here. Only a temporary failure
  // (network error or Auth server 5xx) is "unavailable"; every other error
  // means there is no usable session.
  const { data, error } = await supabase.auth.getUser();
  if (error) {
    if (isAuthRetryableFetchError(error)) {
      console.error(`[admin] auth check failed: ${error.name}`);
      return { kind: "unavailable" };
    }
    return { kind: "anonymous" };
  }
  if (data.user === null) return { kind: "anonymous" };

  const authorization = await checkCurrentUserAdmin(supabase);
  if (authorization === "authorized") return { kind: "admin", supabase };
  if (authorization === "not_authorized") return { kind: "denied", supabase };
  return { kind: "unavailable" };
}

// Read-only "is this request an admin?" for /admin/presence: the same
// database-backed check as requireAdmin(), but it never redirects and never
// signs anyone out. Any failure counts as "not an admin".
export async function isAdminRequest(): Promise<boolean> {
  try {
    return (await checkAdmin()).kind === "admin";
  } catch (error) {
    console.error(`[admin] presence check failed: ${errorName(error)}`);
    return false;
  }
}

// Gate for every admin page and Server Action. Returns a server-only client
// acting as the admin; no user id, email or token is returned for display.
// A confirmed non-admin is signed out everywhere; a check that could not be
// completed only refuses access and leaves every session as it is.
export async function requireAdmin(): Promise<AdminSupabaseClient> {
  const result = await checkAdmin();
  if (result.kind === "anonymous") redirect(ADMIN_LOGIN_PATH);
  if (result.kind === "unavailable") redirect(ADMIN_UNAVAILABLE_PATH);
  if (result.kind === "denied") {
    await signOutGlobally(result.supabase);
    redirect(ADMIN_LOGIN_FAILED_PATH);
  }
  return result.supabase;
}

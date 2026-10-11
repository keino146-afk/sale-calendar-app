import "server-only";

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

type AdminCheck =
  | { kind: "admin"; supabase: AdminSupabaseClient }
  | { kind: "anonymous" }
  | { kind: "denied"; supabase: AdminSupabaseClient };

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

// Asks the database whether the signed-in user is an admin. Any error counts
// as "not an admin".
export async function isCurrentUserAdmin(supabase: AdminSupabaseClient): Promise<boolean> {
  const { data, error } = await supabase.rpc("current_user_is_admin");
  if (error) {
    console.error(`[admin] admin check failed: ${error.code ?? "unknown"}`);
    return false;
  }
  return data === true;
}

// Global sign-out (all of this account's sessions). Failures are logged by
// name only; callers always continue to the login page.
export async function signOutGlobally(supabase: AdminSupabaseClient): Promise<void> {
  try {
    const { error } = await supabase.auth.signOut({ scope: "global" });
    if (error) console.error(`[admin] sign-out failed: ${error.name}`);
  } catch (error) {
    console.error(`[admin] sign-out failed: ${errorName(error)}`);
  }
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
  // revoked or expired session is rejected here.
  const { data, error } = await supabase.auth.getUser();
  if (error || data.user === null) return { kind: "anonymous" };

  return (await isCurrentUserAdmin(supabase))
    ? { kind: "admin", supabase }
    : { kind: "denied", supabase };
}

// Gate for every admin page and Server Action. Returns a server-only client
// acting as the admin; no user id, email or token is returned for display.
export async function requireAdmin(): Promise<AdminSupabaseClient> {
  const result = await checkAdmin();
  if (result.kind === "anonymous") redirect(ADMIN_LOGIN_PATH);
  if (result.kind === "denied") {
    await signOutGlobally(result.supabase);
    redirect(ADMIN_LOGIN_FAILED_PATH);
  }
  return result.supabase;
}

import "server-only";

import { cookies, headers } from "next/headers";
import { adminCookieOptions, createAdminSupabaseClient } from "@/server/supabase/admin-client";
import { isCurrentUserAdmin, signOutGlobally } from "./admin-session";

export type LoginCredentials = { email: string; password: string };

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

// Explicit validation of the login form. Returns null for anything invalid;
// the caller shows the same generic error as for wrong credentials.
export function parseLoginForm(formData: FormData): LoginCredentials | null {
  const email = formData.get("email");
  const password = formData.get("password");
  if (typeof email !== "string" || typeof password !== "string") return null;

  const trimmedEmail = email.trim();
  if (trimmedEmail.length < 3 || trimmedEmail.length > 254) return null;
  if (!EMAIL_PATTERN.test(trimmedEmail)) return null;
  if (password.length < 1 || password.length > 1024) return null;

  return { email: trimmedEmail, password };
}

// True only when the Origin header is present and its host equals the
// request host. Next.js already rejects mismatches for Server Actions but
// lets requests without Origin through; admin actions reject those too.
export function isSameOrigin(origin: string | null, host: string | null): boolean {
  if (origin === null || host === null || host === "") return false;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  return parsed.host.toLowerCase() === host.toLowerCase();
}

// Same host source as Next.js' own Server Action check.
export async function isSameOriginRequest(): Promise<boolean> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || requestHeaders.get("host");
  return isSameOrigin(requestHeaders.get("origin"), host ?? null);
}

// Signs in and keeps the session only for admins. Wrong credentials and
// non-admin accounts both return false; nothing about the account leaks.
export async function signInAdmin({ email, password }: LoginCredentials): Promise<boolean> {
  let supabase;
  try {
    supabase = await createAdminSupabaseClient();
  } catch (error) {
    console.error(`[admin] auth unavailable: ${error instanceof Error ? error.name : "UnknownError"}`);
    return false;
  }

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || data.session === null) {
    console.error(`[admin] login failed: ${error?.name ?? "NoSession"}`);
    return false;
  }

  if (await isCurrentUserAdmin(supabase)) return true;

  await signOutGlobally(supabase);
  return false;
}

// Global sign-out, then removes any remaining admin auth cookies so the
// browser is logged out even if the Auth API call failed.
export async function signOutAdmin(): Promise<void> {
  try {
    await signOutGlobally(await createAdminSupabaseClient());
  } catch (error) {
    console.error(`[admin] sign-out failed: ${error instanceof Error ? error.name : "UnknownError"}`);
  }

  const cookieStore = await cookies();
  for (const { name } of cookieStore.getAll()) {
    if (name.startsWith("sb-") && name.includes("-auth-token")) {
      cookieStore.set(name, "", { ...adminCookieOptions(), maxAge: 0 });
    }
  }
}

import "server-only";

import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { getSupabasePublicEnv } from "@/server/env";
import type { Database } from "./database.types";

// Cookie-based Supabase client for the admin area only. It uses the
// publishable key (never service_role) and acts as the signed-in user, so
// every query still goes through RLS and the lifecycle RPCs' admin checks.
// There is no browser client: the auth cookies are HttpOnly and scoped to
// /admin, so public pages never receive them.

export type AdminSupabaseClient = SupabaseClient<Database>;

export const ADMIN_COOKIE_PATH = "/admin";

export function adminCookieOptions(): CookieOptions {
  return {
    path: ADMIN_COOKIE_PATH,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  };
}

function noStoreFetch(input: RequestInfo | URL, init?: RequestInit) {
  return fetch(input, { ...init, cache: "no-store" });
}

// One client per request (never shared). In Server Components cookies are
// read-only, so writes are skipped there; src/proxy.ts refreshes the session
// before the page renders, and Server Actions can write cookies normally.
export async function createAdminSupabaseClient(): Promise<AdminSupabaseClient> {
  const { url, publishableKey } = getSupabasePublicEnv();
  const cookieStore = await cookies();
  return createServerClient<Database>(url, publishableKey, {
    cookieOptions: adminCookieOptions(),
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Read-only cookies (Server Component): the proxy handles refresh.
        }
      },
    },
    global: { fetch: noStoreFetch },
  });
}

// Proxy variant: reads cookies from the request and writes refreshed ones to
// both the forwarded request and the response, as @supabase/ssr requires.
export function createAdminProxyClient(request: NextRequest): {
  supabase: AdminSupabaseClient;
  response: () => NextResponse;
} {
  const { url, publishableKey } = getSupabasePublicEnv();
  let response = NextResponse.next({ request });
  const supabase = createServerClient<Database>(url, publishableKey, {
    cookieOptions: adminCookieOptions(),
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers ?? {})) {
          response.headers.set(key, value);
        }
      },
    },
    global: { fetch: noStoreFetch },
  });
  return { supabase, response: () => response };
}

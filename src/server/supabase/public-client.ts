import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSupabasePublicEnv } from "@/server/env";
import type { Database } from "./database.types";

// Anonymous, session-less client for public reads under RLS. It never reads
// cookies or stores sessions, and it uses only the publishable key.
// Admin (cookie-based SSR auth) must use a separate client.

export type PublicSupabaseClient = SupabaseClient<Database>;

// Upper bound for each PostgREST request, so a request that never answers
// cannot hold a page indefinitely. Normal public reads take well under a
// second. An aborted request is not retried by postgrest-js; it fails like
// any other read error (pages then show their error state).
export const PUBLIC_DB_TIMEOUT_MS = 5000;

let client: PublicSupabaseClient | undefined;

export function getPublicSupabaseClient(): PublicSupabaseClient {
  if (client === undefined) {
    const { url, publishableKey } = getSupabasePublicEnv();
    client = createClient<Database>(url, publishableKey, {
      auth: {
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
      global: {
        // Avoid serving stale public data from Next.js' fetch cache.
        fetch: (input, init) => fetch(input, { ...init, cache: "no-store" }),
      },
      db: { timeout: PUBLIC_DB_TIMEOUT_MS },
    });
  }
  return client;
}

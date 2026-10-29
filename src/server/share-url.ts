import "server-only";
import { siteUrl } from "@/lib/site";
import { getSupabasePublicEnv } from "@/server/env";

// Whether this deployment may hand out Production links to its sales. Sale
// ids differ between Preview and Production, so a Production URL built from
// another deployment's id would point at a missing (or different) sale.
// Both must hold, or the answer is no:
//   1. Vercel says this is the Production deployment (VERCEL_ENV), and
//   2. the configured Supabase project is this app's Production project.
// Anything else (Preview, development, local, unset or unknown values, an
// invalid or unreadable Supabase setting) fails closed. Values are never
// returned or logged.

// sale-calendar-app-production (not a secret: it is part of the public API
// host). Compared against the exact host name, never as a substring.
export const PRODUCTION_SUPABASE_PROJECT_REF = "yrgwaopxuaqhnutivuni";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isProductionSupabaseOrigin(origin: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "https:" &&
    parsed.port === "" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hostname === `${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`
  );
}

export function isProductionDeployment(): boolean {
  if (process.env.VERCEL_ENV !== "production") return false;
  let origin: string;
  try {
    origin = getSupabasePublicEnv().url;
  } catch {
    return false;
  }
  return isProductionSupabaseOrigin(origin);
}

// The Production URL to share for a published sale, or null when this
// deployment must not hand one out (see above) or the id is not a sale id.
export function productionSaleUrl(saleId: string): string | null {
  if (!UUID_PATTERN.test(saleId)) return null;
  if (!isProductionDeployment()) return null;
  return siteUrl(`/sales/${saleId.toLowerCase()}`);
}

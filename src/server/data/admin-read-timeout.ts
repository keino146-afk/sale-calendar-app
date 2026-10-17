import "server-only";

// Upper bound for one admin screen read (list, detail, edit form, retailer or
// candidate lookup), including postgrest-js' automatic retries of GET reads.
// Normal reads take well under a second; past this the read is treated as a
// failure and the page shows its usual load error.
//
// Only for reads that change nothing. Never pass it to writes (the insert,
// the content-update, lifecycle or import RPCs): aborting a write leaves its
// outcome unknown. Never pass it to the admin-check RPC (any error there
// signs the admin out everywhere), to the manual-source policy RPC (part of a
// save) or to Auth calls. admin-security.test.ts pins these exclusions.
export const ADMIN_READ_TIMEOUT_MS = 10_000;

// A new signal per read: an AbortSignal.timeout() starts counting when it is
// created and cannot be reused.
export function adminReadSignal(): AbortSignal {
  return AbortSignal.timeout(ADMIN_READ_TIMEOUT_MS);
}

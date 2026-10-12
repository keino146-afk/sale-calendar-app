// Generic URL canonicalization for external keys: https only, lower-case
// host, no fragment, and common tracking parameters removed. Source-specific
// rules belong to each adapter's normalizer.

const TRACKING_PARAMETER = /^(utm_[a-z_]+|fbclid|gclid|yclid|mc_cid|mc_eid)$/i;

export function canonicalizeSourceUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
    return null;
  }
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (TRACKING_PARAMETER.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.toString();
}

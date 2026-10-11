// Server-side pre-check mirroring public.reject_sale_event(): NFKC
// normalization, leading/trailing whitespace trimmed, 1-2000 characters.
// The RPC repeats the same rules and stays the final authority.

export const REJECT_REASON_MAX_LENGTH = 2000;
// Raw input cap before normalization, so huge payloads are refused early.
const RAW_INPUT_MAX_LENGTH = 10000;

export function normalizeRejectReason(value: unknown): string | null {
  if (typeof value !== "string" || value.length > RAW_INPUT_MAX_LENGTH) return null;
  const normalized = value.normalize("NFKC").replace(/^\s+/u, "").replace(/\s+$/u, "");
  const length = [...normalized].length; // code points, like char_length()
  if (length < 1 || length > REJECT_REASON_MAX_LENGTH) return null;
  return normalized;
}

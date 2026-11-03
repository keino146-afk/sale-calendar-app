import "server-only";

import { hash } from "node:crypto";
import { cookies } from "next/headers";
import { P6_FORM_FIELDS, pickP6RawForm, type P6RawForm } from "@/lib/p6-usage-form";

// The usage form as last submitted, kept between "確認する" and "記録する"
// so the numbers never go into a URL (history, access logs). HttpOnly,
// SameSite=Strict, only sent to /admin/usage, and short-lived. It holds the
// admin's own input only (no identity, no secret); the commit re-parses it
// and the database validates it again, so a changed cookie can do no more
// than the form itself.
//
// The cookie is not signed. p6DraftDigest() only ties the confirmation the
// admin saw to the draft the commit stores (another tab may have replaced
// the draft in between); it is not tamper protection or authentication.

export const P6_DRAFT_COOKIE = "p6_usage_draft";
export const P6_DRAFT_PATH = "/admin/usage";
const MAX_AGE_SECONDS = 30 * 60;
const MAX_COOKIE_LENGTH = 3500;

function options(maxAge: number) {
  return {
    path: P6_DRAFT_PATH,
    httpOnly: true,
    sameSite: "strict" as const,
    secure: process.env.NODE_ENV === "production",
    maxAge,
  };
}

// False when the draft is too large to keep. Any earlier draft is then
// removed, so it can never be confirmed or stored in place of this one.
export async function saveP6Draft(raw: P6RawForm): Promise<boolean> {
  const value = Buffer.from(JSON.stringify(raw), "utf8").toString("base64url");
  if (value.length > MAX_COOKIE_LENGTH) {
    await clearP6Draft();
    return false;
  }
  (await cookies()).set(P6_DRAFT_COOKIE, value, options(MAX_AGE_SECONDS));
  return true;
}

export async function readP6Draft(): Promise<P6RawForm | null> {
  const value = (await cookies()).get(P6_DRAFT_COOKIE)?.value;
  if (value === undefined || value.length > MAX_COOKIE_LENGTH) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const record = parsed as Record<string, unknown>;
    return pickP6RawForm((name) => record[name]);
  } catch {
    return null;
  }
}

// SHA-256 (hex) of the draft as read back, in the fixed field order. The
// confirmation form carries it; the commit refuses a draft whose digest
// differs. Equal digests mean the same fields with the same text.
export function p6DraftDigest(raw: P6RawForm): string {
  const fields = P6_FORM_FIELDS.map((name) => (Object.hasOwn(raw, name) ? raw[name] : null));
  return hash("sha256", `p6-draft-v1\n${JSON.stringify(fields)}`, "hex");
}

// Expired at once (same path and flags as when it was set).
export async function clearP6Draft(): Promise<void> {
  (await cookies()).set(P6_DRAFT_COOKIE, "", options(0));
}

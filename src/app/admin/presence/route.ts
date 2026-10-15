import { isAdminRequest } from "@/server/auth/admin-session";

// GET /admin/presence: tells the public home page whether to show its
// "管理画面へ" link. Under /admin so the Path=/admin session cookie is sent;
// public pages themselves never run session code. Read only and never a
// redirect (a followed redirect could look like success): 200 with exactly
// {"isAdmin":true} for an admin, an empty 204 for everyone else, including
// any failure. No identity or error detail is returned, and nothing is
// cached. This is a convenience only: /admin pages still call requireAdmin().

const NO_STORE = { "Cache-Control": "private, no-store" };

export async function GET(): Promise<Response> {
  if (await isAdminRequest()) {
    return Response.json({ isAdmin: true }, { status: 200, headers: NO_STORE });
  }
  return new Response(null, { status: 204, headers: NO_STORE });
}

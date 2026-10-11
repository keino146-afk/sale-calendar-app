import { NextResponse, type NextRequest } from "next/server";
import { createAdminProxyClient } from "@/server/supabase/admin-client";

// Refreshes the admin session cookies before /admin pages render (Server
// Components cannot write cookies). This is not an authorization gate:
// every admin page and Server Action calls requireAdmin() itself.
export async function proxy(request: NextRequest): Promise<NextResponse> {
  let client: ReturnType<typeof createAdminProxyClient>;
  try {
    client = createAdminProxyClient(request);
  } catch {
    // Missing configuration: let the page's own checks handle it.
    return NextResponse.next({ request });
  }

  try {
    await client.supabase.auth.getUser();
  } catch (error) {
    console.error(`[admin] session refresh failed: ${error instanceof Error ? error.name : "UnknownError"}`);
  }
  return client.response();
}

// Admin routes only: public pages never run auth/session code.
export const config = {
  matcher: ["/admin", "/admin/:path*"],
};

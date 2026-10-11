import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { createAdminProxyClient } = vi.hoisted(() => ({ createAdminProxyClient: vi.fn() }));

vi.mock("@/server/supabase/admin-client", () => ({ createAdminProxyClient }));

const { proxy, config } = await import("./proxy");

afterEach(() => {
  vi.restoreAllMocks();
  createAdminProxyClient.mockReset();
});

function matches(pattern: string, path: string): boolean {
  // Minimal matcher semantics used here: "/x" exact, "/x/:path*" for subpaths.
  if (pattern.endsWith("/:path*")) return path.startsWith(`${pattern.slice(0, -"/:path*".length)}/`);
  return path === pattern;
}

describe("proxy config", () => {
  it("runs only for /admin routes", () => {
    expect(config.matcher).toEqual(["/admin", "/admin/:path*"]);
    const covered = (path: string) => config.matcher.some((pattern) => matches(pattern, path));
    for (const path of ["/admin", "/admin/login", "/admin/sales/x"]) expect(covered(path)).toBe(true);
    for (const path of ["/", "/calendar", "/sales/x", "/administrator", "/api/admin"]) {
      expect(covered(path)).toBe(false);
    }
  });
});

describe("proxy", () => {
  it("refreshes the session and returns the client's response", async () => {
    const response = NextResponse.next();
    const getUser = vi.fn(async () => ({ data: { user: null }, error: null }));
    createAdminProxyClient.mockReturnValue({ supabase: { auth: { getUser } }, response: () => response });

    const result = await proxy(new NextRequest("https://example.com/admin"));

    expect(getUser).toHaveBeenCalledTimes(1);
    expect(result).toBe(response);
  });

  it("passes through when auth is not configured", async () => {
    createAdminProxyClient.mockImplementation(() => {
      throw new Error("SUPABASE_URL is not set");
    });

    const result = await proxy(new NextRequest("https://example.com/admin"));

    expect(result.status).toBe(200);
    expect(result.headers.get("set-cookie")).toBeNull();
  });

  it("does not fail the request when the refresh call throws", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const response = NextResponse.next();
    createAdminProxyClient.mockReturnValue({
      supabase: { auth: { getUser: vi.fn(async () => Promise.reject(new Error("network"))) } },
      response: () => response,
    });

    await expect(proxy(new NextRequest("https://example.com/admin"))).resolves.toBe(response);
  });
});

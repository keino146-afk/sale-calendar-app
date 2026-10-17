import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createServerClient, cookieStore } = vi.hoisted(() => ({
  createServerClient: vi.fn(() => ({ auth: {} })),
  cookieStore: { getAll: vi.fn(() => [{ name: "sb-x-auth-token", value: "v" }]), set: vi.fn() },
}));

vi.mock("@supabase/ssr", () => ({ createServerClient }));
vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));

const { adminCookieOptions, createAdminSupabaseClient, createAdminProxyClient } = await import(
  "./admin-client"
);

// Fake values only; not a real project or key.
const FAKE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const FAKE_KEY = "sb_publishable_FAKE_TEST_KEY";

type ServerClientOptions = {
  cookieOptions: Record<string, unknown>;
  cookies: {
    getAll: () => unknown;
    setAll: (
      cookies: { name: string; value: string; options: Record<string, unknown> }[],
      headers?: Record<string, string>,
    ) => void;
  };
};

function lastOptions(): ServerClientOptions {
  const calls = createServerClient.mock.calls as unknown as [string, string, ServerClientOptions][];
  return calls[calls.length - 1][2];
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", FAKE_URL);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", FAKE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  createServerClient.mockClear();
  cookieStore.set.mockReset();
});

describe("adminCookieOptions", () => {
  it("is HttpOnly, SameSite=Lax and scoped to /admin", () => {
    expect(adminCookieOptions()).toMatchObject({ path: "/admin", httpOnly: true, sameSite: "lax" });
  });

  it("is Secure only in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(adminCookieOptions().secure).toBe(true);
    vi.stubEnv("NODE_ENV", "development");
    expect(adminCookieOptions().secure).toBe(false);
  });
});

describe("createAdminSupabaseClient", () => {
  it("keeps the library's default request handling (no public-read timeout)", async () => {
    await createAdminSupabaseClient();

    // The 5 s PostgREST timeout is for anonymous public reads only.
    expect(lastOptions()).not.toHaveProperty("db");
  });

  it("uses only the URL and publishable key with admin cookie options", async () => {
    await createAdminSupabaseClient();

    const [url, key] = createServerClient.mock.calls[0] as unknown as [string, string];
    expect(url).toBe(FAKE_URL);
    expect(key).toBe(FAKE_KEY);
    expect(lastOptions().cookieOptions).toMatchObject({ path: "/admin", httpOnly: true, sameSite: "lax" });
  });

  it("reads and writes cookies through the Next.js cookie store", async () => {
    await createAdminSupabaseClient();
    const { cookies } = lastOptions();

    expect(cookies.getAll()).toEqual([{ name: "sb-x-auth-token", value: "v" }]);
    cookies.setAll([{ name: "sb-x-auth-token", value: "new", options: { path: "/admin", httpOnly: true } }]);
    expect(cookieStore.set).toHaveBeenCalledWith("sb-x-auth-token", "new", {
      path: "/admin",
      httpOnly: true,
    });
  });

  it("ignores cookie writes where cookies are read-only", async () => {
    cookieStore.set.mockImplementation(() => {
      throw new Error("Cookies can only be modified in a Server Action or Route Handler");
    });
    await createAdminSupabaseClient();

    expect(() => lastOptions().cookies.setAll([{ name: "a", value: "b", options: {} }])).not.toThrow();
  });

  it("refuses to start without configuration", async () => {
    vi.stubEnv("SUPABASE_URL", "");
    await expect(createAdminSupabaseClient()).rejects.toThrow("SUPABASE_URL is not set");
    expect(createServerClient).not.toHaveBeenCalled();
  });
});

describe("createAdminProxyClient", () => {
  it("writes refreshed cookies to the response with the admin options", async () => {
    const { NextRequest } = await import("next/server");
    const request = new NextRequest("https://example.com/admin", {
      headers: { cookie: "sb-x-auth-token=old" },
    });
    const { response } = createAdminProxyClient(request);
    const { cookies } = lastOptions();

    expect(cookies.getAll()).toEqual([{ name: "sb-x-auth-token", value: "old" }]);
    cookies.setAll(
      [{ name: "sb-x-auth-token", value: "new", options: adminCookieOptions() as Record<string, unknown> }],
      { "Cache-Control": "private, no-store" },
    );

    const setCookie = response().headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("sb-x-auth-token=new");
    expect(setCookie).toMatch(/Path=\/admin/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(response().headers.get("cache-control")).toBe("private, no-store");
    expect(request.cookies.get("sb-x-auth-token")?.value).toBe("new");
  });
});

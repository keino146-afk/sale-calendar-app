import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminSupabaseClient, cookieStore, requestHeaders } = vi.hoisted(() => ({
  createAdminSupabaseClient: vi.fn(),
  cookieStore: { getAll: vi.fn(), set: vi.fn() },
  requestHeaders: new Map<string, string>(),
}));

vi.mock("@/server/supabase/admin-client", () => ({
  createAdminSupabaseClient,
  adminCookieOptions: () => ({ path: "/admin", httpOnly: true, sameSite: "lax", secure: false }),
}));
vi.mock("next/headers", () => ({
  cookies: async () => cookieStore,
  headers: async () => ({ get: (name: string) => requestHeaders.get(name) ?? null }),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));

const { parseLoginForm, isSameOrigin, isSameOriginRequest, signInAdmin, signOutAdmin } =
  await import("./admin-auth");

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

function fakeClient({
  signInError = null as Error | null,
  session = { access_token: "fake" } as object | null,
  isAdmin = true as boolean | null,
  rpcError = null as { code: string } | null,
} = {}) {
  return {
    auth: {
      signInWithPassword: vi.fn(async () => ({ data: { session }, error: signInError })),
      signOut: vi.fn(async () => ({ error: null })),
    },
    rpc: vi.fn(async () => ({ data: isAdmin, error: rpcError })),
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  cookieStore.getAll.mockReturnValue([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  createAdminSupabaseClient.mockReset();
  cookieStore.getAll.mockReset();
  cookieStore.set.mockReset();
  requestHeaders.clear();
});

describe("parseLoginForm", () => {
  it("accepts a valid email and password, trimming only the email", () => {
    expect(parseLoginForm(form({ email: "  admin@example.invalid ", password: " pass word " }))).toEqual({
      email: "admin@example.invalid",
      password: " pass word ",
    });
  });

  it.each([
    ["missing email", { password: "x" }],
    ["missing password", { email: "a@b.c" }],
    ["empty password", { email: "a@b.c", password: "" }],
    ["no at sign", { email: "admin.example", password: "x" }],
    ["spaces in email", { email: "ad min@example.invalid", password: "x" }],
    ["too long email", { email: `${"a".repeat(250)}@b.cd`, password: "x" }],
    ["too long password", { email: "a@b.c", password: "x".repeat(1025) }],
  ])("rejects %s", (_label, fields) => {
    expect(parseLoginForm(form(fields as Record<string, string>))).toBeNull();
  });

  it("rejects file uploads in place of text", () => {
    const data = new FormData();
    data.set("email", new Blob(["a@b.c"]));
    data.set("password", "x");
    expect(parseLoginForm(data)).toBeNull();
  });
});

describe("isSameOrigin", () => {
  it("accepts a matching origin host", () => {
    expect(isSameOrigin("https://sale-calendar-app.vercel.app", "sale-calendar-app.vercel.app")).toBe(true);
    expect(isSameOrigin("http://127.0.0.1:3000", "127.0.0.1:3000")).toBe(true);
    expect(isSameOrigin("https://Example.COM", "example.com")).toBe(true);
  });

  it.each([
    ["missing origin", null, "example.com"],
    ["missing host", "https://example.com", null],
    ["empty host", "https://example.com", ""],
    ["foreign origin", "https://evil.example", "example.com"],
    ["port mismatch", "http://127.0.0.1:4000", "127.0.0.1:3000"],
    ["subdomain", "https://a.example.com", "example.com"],
    ["opaque origin", "null", "example.com"],
    ["non-http scheme", "file://example.com", "example.com"],
  ])("rejects %s", (_label, origin, host) => {
    expect(isSameOrigin(origin, host)).toBe(false);
  });
});

describe("isSameOriginRequest", () => {
  it("uses x-forwarded-host first, then host", async () => {
    requestHeaders.set("origin", "https://preview.example.app");
    requestHeaders.set("x-forwarded-host", "preview.example.app, internal");
    requestHeaders.set("host", "internal");
    expect(await isSameOriginRequest()).toBe(true);

    requestHeaders.delete("x-forwarded-host");
    expect(await isSameOriginRequest()).toBe(false);
  });

  it("rejects a request without an Origin header", async () => {
    requestHeaders.set("host", "example.com");
    expect(await isSameOriginRequest()).toBe(false);
  });
});

describe("signInAdmin", () => {
  const credentials = { email: "admin@example.invalid", password: "correct" };

  it("signs an admin in and keeps the session", async () => {
    const client = fakeClient();
    createAdminSupabaseClient.mockResolvedValue(client);

    expect(await signInAdmin(credentials)).toBe(true);
    expect(client.auth.signInWithPassword).toHaveBeenCalledWith(credentials);
    expect(client.rpc).toHaveBeenCalledWith("current_user_is_admin");
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("fails generically for a wrong password without checking admin", async () => {
    const client = fakeClient({
      signInError: Object.assign(new Error("Invalid login credentials"), { name: "AuthApiError" }),
      session: null,
    });
    createAdminSupabaseClient.mockResolvedValue(client);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await signInAdmin(credentials)).toBe(false);
    expect(client.rpc).not.toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("AuthApiError");
    expect(logged).not.toContain("Invalid login credentials");
    expect(logged).not.toContain(credentials.email);
  });

  it("signs a non-admin out globally and fails", async () => {
    const client = fakeClient({ isAdmin: false });
    createAdminSupabaseClient.mockResolvedValue(client);

    expect(await signInAdmin(credentials)).toBe(false);
    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it.each([
    ["errors", { isAdmin: null, rpcError: { code: "PGRST000" } }],
    ["errors alongside true", { isAdmin: true, rpcError: { code: "PGRST000" } }],
    ["returns no boolean", { isAdmin: null }],
  ])("ends only the new session and fails generically when the admin check %s", async (_label, options) => {
    const client = fakeClient(options);
    createAdminSupabaseClient.mockResolvedValue(client);

    expect(await signInAdmin(credentials)).toBe(false);
    // Same result as a wrong password; other devices' sessions are untouched.
    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });

  it("fails when auth is not configured", async () => {
    createAdminSupabaseClient.mockRejectedValue(new Error("SUPABASE_URL is not set"));

    expect(await signInAdmin(credentials)).toBe(false);
  });
});

describe("signOutAdmin", () => {
  it("signs out globally and expires the admin auth cookies", async () => {
    const client = fakeClient();
    createAdminSupabaseClient.mockResolvedValue(client);
    cookieStore.getAll.mockReturnValue([
      { name: "sb-abc-auth-token", value: "x" },
      { name: "sb-abc-auth-token.0", value: "x" },
      { name: "unrelated", value: "x" },
    ]);

    await signOutAdmin();

    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "global" });
    expect(cookieStore.set.mock.calls.map(([name]) => name)).toEqual([
      "sb-abc-auth-token",
      "sb-abc-auth-token.0",
    ]);
    for (const [, value, options] of cookieStore.set.mock.calls) {
      expect(value).toBe("");
      expect(options).toMatchObject({ path: "/admin", httpOnly: true, maxAge: 0 });
    }
  });

  it("still expires cookies when the sign-out call fails", async () => {
    const client = fakeClient();
    client.auth.signOut.mockRejectedValue(new Error("network"));
    createAdminSupabaseClient.mockResolvedValue(client);
    cookieStore.getAll.mockReturnValue([{ name: "sb-abc-auth-token", value: "x" }]);

    await signOutAdmin();

    expect(cookieStore.set).toHaveBeenCalledTimes(1);
  });
});

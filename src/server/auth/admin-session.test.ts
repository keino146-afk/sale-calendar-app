import { AuthApiError, AuthRetryableFetchError, AuthSessionMissingError } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAdminSupabaseClient, redirect, REDIRECT } = vi.hoisted(() => {
  class RedirectSentinel extends Error {
    constructor(public readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return {
    createAdminSupabaseClient: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new RedirectSentinel(url);
    }),
    REDIRECT: RedirectSentinel,
  };
});

vi.mock("@/server/supabase/admin-client", () => ({ createAdminSupabaseClient }));
vi.mock("next/navigation", () => ({ redirect }));

const {
  requireAdmin,
  checkCurrentUserAdmin,
  isAdminRequest,
  ADMIN_LOGIN_PATH,
  ADMIN_LOGIN_FAILED_PATH,
  ADMIN_UNAVAILABLE_PATH,
} = await import("./admin-session");

// Fake ids only.
const USER = { id: "00000000-0000-4000-8000-0000000000aa", email: "admin@example.invalid" };

function fakeClient({
  user = USER as typeof USER | null,
  userError = null as Error | null,
  isAdmin = true as unknown,
  rpcError = null as { code: string } | null,
} = {}) {
  return {
    auth: {
      getUser: vi.fn(async () => ({ data: { user }, error: userError })),
      signOut: vi.fn(async () => ({ error: null })),
    },
    rpc: vi.fn(async () => ({ data: isAdmin, error: rpcError })),
  };
}

async function expectRedirect(promise: Promise<unknown>, url: string) {
  await expect(promise).rejects.toBeInstanceOf(REDIRECT);
  await promise.catch((error: InstanceType<typeof REDIRECT>) => expect(error.url).toBe(url));
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  createAdminSupabaseClient.mockReset();
  redirect.mockClear();
});

describe("requireAdmin", () => {
  it("returns the client for an admin after verifying the user server-side", async () => {
    const client = fakeClient();
    createAdminSupabaseClient.mockResolvedValue(client);

    await expect(requireAdmin()).resolves.toBe(client);
    expect(client.auth.getUser).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("current_user_is_admin");
    expect(client.auth.signOut).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });

  it("redirects to the login page when nobody is signed in", async () => {
    const client = fakeClient({ user: null });
    createAdminSupabaseClient.mockResolvedValue(client);

    await expectRedirect(requireAdmin(), ADMIN_LOGIN_PATH);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("redirects to the login page for an expired or revoked session", async () => {
    const client = fakeClient({ user: null, userError: new Error("JWT expired") });
    createAdminSupabaseClient.mockResolvedValue(client);

    await expectRedirect(requireAdmin(), ADMIN_LOGIN_PATH);
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("signs a non-admin out globally and shows the generic failure", async () => {
    const client = fakeClient({ isAdmin: false });
    createAdminSupabaseClient.mockResolvedValue(client);

    await expectRedirect(requireAdmin(), ADMIN_LOGIN_FAILED_PATH);
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it("signs a confirmed non-admin out exactly once, globally", async () => {
    const client = fakeClient({ isAdmin: false });
    createAdminSupabaseClient.mockResolvedValue(client);

    await expectRedirect(requireAdmin(), ADMIN_LOGIN_FAILED_PATH);
    expect(client.auth.signOut).toHaveBeenCalledTimes(1);
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it.each([
    ["an error", { isAdmin: null, rpcError: { code: "PGRST000" } }],
    ["an error alongside a true value", { isAdmin: true, rpcError: { code: "PGRST000" } }],
    ["a null value", { isAdmin: null }],
    ["a string value", { isAdmin: "true" }],
    ["a number value", { isAdmin: 1 }],
    ["an object value", { isAdmin: {} }],
  ])("refuses access but keeps every session when the admin check returns %s", async (_label, options) => {
    const client = fakeClient(options);
    createAdminSupabaseClient.mockResolvedValue(client);

    await expectRedirect(requireAdmin(), ADMIN_UNAVAILABLE_PATH);
    // No sign-out of any scope: the only way requireAdmin ends a session or
    // clears its cookies.
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it.each([
    ["a network failure", new AuthRetryableFetchError("fetch failed", 0)],
    ["an Auth server error", new AuthRetryableFetchError("Service Unavailable", 503)],
  ])("refuses access but keeps the session when Auth has %s", async (_label, userError) => {
    const client = fakeClient({ user: null, userError });
    createAdminSupabaseClient.mockResolvedValue(client);

    await expectRedirect(requireAdmin(), ADMIN_UNAVAILABLE_PATH);
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it.each([
    ["a missing session", new AuthSessionMissingError()],
    ["an invalid session (401)", new AuthApiError("invalid JWT", 401, "bad_jwt")],
    ["a forbidden session (403)", new AuthApiError("session not found", 403, "session_not_found")],
  ])("sends %s to the login page without signing out", async (_label, userError) => {
    const client = fakeClient({ user: null, userError });
    createAdminSupabaseClient.mockResolvedValue(client);

    await expectRedirect(requireAdmin(), ADMIN_LOGIN_PATH);
    expect(client.rpc).not.toHaveBeenCalled();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("redirects to the login page when auth is not configured", async () => {
    createAdminSupabaseClient.mockRejectedValue(new Error("SUPABASE_URL is not set"));

    await expectRedirect(requireAdmin(), ADMIN_LOGIN_PATH);
  });

  it("still redirects when the sign-out call fails", async () => {
    const client = fakeClient({ isAdmin: false });
    client.auth.signOut.mockRejectedValue(new Error("network"));
    createAdminSupabaseClient.mockResolvedValue(client);

    await expectRedirect(requireAdmin(), ADMIN_LOGIN_FAILED_PATH);
  });

  it("logs no user id, email or raw message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const denied = fakeClient({ isAdmin: false });
    denied.auth.signOut.mockResolvedValue({ error: Object.assign(new Error("secret detail"), { name: "AuthApiError" }) } as never);
    const failed = fakeClient({ isAdmin: null, rpcError: { code: "42501", message: "secret detail" } as never });
    const authDown = fakeClient({ user: null, userError: new AuthRetryableFetchError("secret detail", 503) });

    for (const client of [denied, failed, authDown]) {
      createAdminSupabaseClient.mockResolvedValue(client);
      await requireAdmin().catch(() => {});
    }

    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("42501");
    expect(logged).toContain("AuthRetryableFetchError");
    expect(logged).not.toContain(USER.id);
    expect(logged).not.toContain(USER.email);
    expect(logged).not.toContain("secret detail");
  });
});

describe("checkCurrentUserAdmin", () => {
  it("answers only a plain boolean without an error", async () => {
    expect(await checkCurrentUserAdmin(fakeClient({ isAdmin: true }) as never)).toBe("authorized");
    expect(await checkCurrentUserAdmin(fakeClient({ isAdmin: false }) as never)).toBe("not_authorized");
  });

  it.each([
    ["an error", { isAdmin: null, rpcError: { code: "PGRST000" } }],
    ["an error alongside true", { isAdmin: true, rpcError: { code: "PGRST000" } }],
    ["an error alongside false", { isAdmin: false, rpcError: { code: "PGRST000" } }],
    ["null", { isAdmin: null }],
    ["a non-boolean", { isAdmin: "true" }],
  ])("is check_failed (never authorized) for %s", async (_label, options) => {
    expect(await checkCurrentUserAdmin(fakeClient(options) as never)).toBe("check_failed");
  });
});

describe("isAdminRequest", () => {
  it("is true only for an admin verified through current_user_is_admin", async () => {
    const client = fakeClient();
    createAdminSupabaseClient.mockResolvedValue(client);

    expect(await isAdminRequest()).toBe(true);
    expect(client.auth.getUser).toHaveBeenCalledTimes(1);
    expect(client.rpc).toHaveBeenCalledWith("current_user_is_admin");
  });

  it.each([
    ["an anonymous visitor", { user: null }],
    ["an unusable session", { user: null, userError: new Error("expired") }],
    ["a signed-in non-admin (e.g. a collector)", { isAdmin: false }],
    ["a failed admin check", { isAdmin: null, rpcError: { code: "PGRST000" } }],
    ["a failed admin check that also returned true", { isAdmin: true, rpcError: { code: "PGRST000" } }],
    ["an Auth outage", { user: null, userError: new AuthRetryableFetchError("Service Unavailable", 503) }],
  ])("is false for %s, without redirecting or signing out", async (_label, options) => {
    const client = fakeClient(options);
    createAdminSupabaseClient.mockResolvedValue(client);

    expect(await isAdminRequest()).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
    expect(client.auth.signOut).not.toHaveBeenCalled();
  });

  it("is false when auth is unavailable or throws", async () => {
    createAdminSupabaseClient.mockRejectedValue(new Error("config"));
    expect(await isAdminRequest()).toBe(false);

    const client = fakeClient();
    client.auth.getUser.mockRejectedValue(new Error("network"));
    createAdminSupabaseClient.mockResolvedValue(client);
    expect(await isAdminRequest()).toBe(false);
    expect(redirect).not.toHaveBeenCalled();
  });
});

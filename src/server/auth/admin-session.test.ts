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

const { requireAdmin, isCurrentUserAdmin, isAdminRequest, ADMIN_LOGIN_PATH, ADMIN_LOGIN_FAILED_PATH } =
  await import("./admin-session");

// Fake ids only.
const USER = { id: "00000000-0000-4000-8000-0000000000aa", email: "admin@example.invalid" };

function fakeClient({
  user = USER as typeof USER | null,
  userError = null as Error | null,
  isAdmin = true as boolean | null,
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

  it("treats an admin-check error as not an admin", async () => {
    const client = fakeClient({ isAdmin: null, rpcError: { code: "PGRST202" } });
    createAdminSupabaseClient.mockResolvedValue(client);

    await expectRedirect(requireAdmin(), ADMIN_LOGIN_FAILED_PATH);
    expect(client.auth.signOut).toHaveBeenCalledWith({ scope: "global" });
  });

  it("requires exactly true from the admin check", async () => {
    for (const value of [null, "true", 1, {}]) {
      const client = fakeClient({ isAdmin: value as never });
      createAdminSupabaseClient.mockResolvedValue(client);
      await expectRedirect(requireAdmin(), ADMIN_LOGIN_FAILED_PATH);
    }
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
    const client = fakeClient({ isAdmin: null, rpcError: { code: "42501" } });
    client.auth.signOut.mockResolvedValue({ error: Object.assign(new Error("secret detail"), { name: "AuthApiError" }) } as never);
    createAdminSupabaseClient.mockResolvedValue(client);

    await requireAdmin().catch(() => {});

    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).not.toContain(USER.id);
    expect(logged).not.toContain(USER.email);
    expect(logged).not.toContain("secret detail");
  });
});

describe("isCurrentUserAdmin", () => {
  it("is true only for a boolean true result", async () => {
    expect(await isCurrentUserAdmin(fakeClient({ isAdmin: true }) as never)).toBe(true);
    expect(await isCurrentUserAdmin(fakeClient({ isAdmin: false }) as never)).toBe(false);
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

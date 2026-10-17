import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClient } = vi.hoisted(() => ({ createClient: vi.fn(() => ({ from: vi.fn() })) }));

vi.mock("@supabase/supabase-js", () => ({ createClient }));

// Fake values only; not a real project or key.
const FAKE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const FAKE_KEY = "sb_publishable_FAKE_TEST_KEY";

type ClientOptions = {
  auth: Record<string, unknown>;
  global: { fetch: (input: string, init?: RequestInit) => Promise<Response> };
  db: { timeout?: number; retry?: boolean };
};

async function freshClient() {
  vi.resetModules();
  const publicClient = await import("./public-client");
  publicClient.getPublicSupabaseClient();
  const calls = createClient.mock.calls as unknown as [string, string, ClientOptions][];
  return { publicClient, call: calls[calls.length - 1] };
}

beforeEach(() => {
  vi.stubEnv("SUPABASE_URL", FAKE_URL);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", FAKE_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  createClient.mockClear();
});

describe("getPublicSupabaseClient", () => {
  it("bounds every PostgREST request at 5 seconds and keeps automatic retries on", async () => {
    const { publicClient, call } = await freshClient();

    expect(publicClient.PUBLIC_DB_TIMEOUT_MS).toBe(5000);
    expect(call[2].db).toEqual({ timeout: 5000 });
    // Retries are not disabled client-wide (only the next-sale hint opts out).
    expect(call[2].db).not.toHaveProperty("retry");
  });

  it("stays anonymous and session-less with the publishable key", async () => {
    const { call } = await freshClient();

    expect(call[0]).toBe(FAKE_URL);
    expect(call[1]).toBe(FAKE_KEY);
    expect(call[2].auth).toEqual({ persistSession: false, autoRefreshToken: false, detectSessionInUrl: false });
  });

  it("keeps bypassing the Next.js fetch cache", async () => {
    const fetchSpy = vi.fn(async () => new Response("[]"));
    vi.stubGlobal("fetch", fetchSpy);
    const { call } = await freshClient();

    await call[2].global.fetch("https://example.invalid/rest/v1/x", { method: "GET" });

    expect(fetchSpy).toHaveBeenCalledWith("https://example.invalid/rest/v1/x", { method: "GET", cache: "no-store" });
  });

  it("creates the client once", async () => {
    const { publicClient } = await freshClient();

    publicClient.getPublicSupabaseClient();
    publicClient.getPublicSupabaseClient();

    expect(createClient).toHaveBeenCalledTimes(1);
  });
});

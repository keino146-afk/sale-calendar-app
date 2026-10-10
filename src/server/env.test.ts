import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabasePublicEnv } from "./env";

// Fake, non-functional values. None of these are real credentials.
const FAKE_URL = "https://abcdefghijklmnopqrst.supabase.co";
const FAKE_KEY = "sb_publishable_FAKE0000test0000value";

function setEnv(url: string | undefined, key: string | undefined) {
  vi.stubEnv("SUPABASE_URL", url);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", key);
}

function errorMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected function to throw");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getSupabasePublicEnv", () => {
  it("returns validated values for a hosted project", () => {
    setEnv(FAKE_URL, FAKE_KEY);
    expect(getSupabasePublicEnv()).toEqual({ url: FAKE_URL, publishableKey: FAKE_KEY });
  });

  it("accepts a trailing slash and normalizes to the origin", () => {
    setEnv(`${FAKE_URL}/`, FAKE_KEY);
    expect(getSupabasePublicEnv().url).toBe(FAKE_URL);
  });

  it("rejects a missing URL", () => {
    setEnv(undefined, FAKE_KEY);
    expect(() => getSupabasePublicEnv()).toThrow("SUPABASE_URL is not set");
  });

  it("rejects an empty URL", () => {
    setEnv("   ", FAKE_KEY);
    expect(() => getSupabasePublicEnv()).toThrow("SUPABASE_URL is not set");
  });

  it("rejects a missing key", () => {
    setEnv(FAKE_URL, undefined);
    expect(() => getSupabasePublicEnv()).toThrow("SUPABASE_PUBLISHABLE_KEY is not set");
  });

  it("rejects a whitespace-only key", () => {
    setEnv(FAKE_URL, " \t ");
    expect(() => getSupabasePublicEnv()).toThrow("SUPABASE_PUBLISHABLE_KEY is not set");
  });

  it("rejects a malformed URL", () => {
    setEnv("not a url", FAKE_KEY);
    expect(() => getSupabasePublicEnv()).toThrow("SUPABASE_URL is not a valid URL");
  });

  it("rejects http for a hosted URL", () => {
    setEnv("http://abcdefghijklmnopqrst.supabase.co", FAKE_KEY);
    expect(() => getSupabasePublicEnv()).toThrow("SUPABASE_URL must use https");
  });

  it.each([
    "https://example.com",
    "https://supabase.co",
    "https://abcdefghijklmnopqrst.supabase.com",
    "https://example.supabase.co.evil.test",
    "https://abcdefghijklmnopqrst.supabase.co.evil.test",
  ])("rejects a non-Supabase or spoofed host: %s", (url) => {
    setEnv(url, FAKE_KEY);
    expect(() => getSupabasePublicEnv()).toThrow("SUPABASE_URL must be a *.supabase.co host");
  });

  it("rejects credentials in the URL", () => {
    setEnv("https://user:pass@abcdefghijklmnopqrst.supabase.co", FAKE_KEY);
    expect(() => getSupabasePublicEnv()).toThrow("SUPABASE_URL must not contain credentials");
  });

  it.each([`${FAKE_URL}/?x=1`, `${FAKE_URL}/#frag`])("rejects a query or fragment: %s", (url) => {
    setEnv(url, FAKE_KEY);
    expect(() => getSupabasePublicEnv()).toThrow(
      "SUPABASE_URL must not contain a query or fragment",
    );
  });

  it("rejects a path", () => {
    setEnv(`${FAKE_URL}/rest/v1`, FAKE_KEY);
    expect(() => getSupabasePublicEnv()).toThrow("SUPABASE_URL must not contain a path");
  });

  it("rejects an explicit port on a hosted URL", () => {
    setEnv("https://abcdefghijklmnopqrst.supabase.co:8443", FAKE_KEY);
    expect(() => getSupabasePublicEnv()).toThrow("SUPABASE_URL must not specify a port");
  });

  it("rejects a secret key", () => {
    setEnv(FAKE_URL, "sb_secret_FAKE0000test0000value");
    expect(() => getSupabasePublicEnv()).toThrow(
      "SUPABASE_PUBLISHABLE_KEY must not be a secret key",
    );
  });

  it("rejects a JWT-format key", () => {
    setEnv(FAKE_URL, "eyJhbGciOiJIUzI1NiJ9.fake.payload");
    expect(() => getSupabasePublicEnv()).toThrow(
      "SUPABASE_PUBLISHABLE_KEY must not be a JWT-format key",
    );
  });

  it("rejects a key without the publishable prefix", () => {
    setEnv(FAKE_URL, "some-other-key");
    expect(() => getSupabasePublicEnv()).toThrow(
      "SUPABASE_PUBLISHABLE_KEY must be a publishable key",
    );
  });

  it.each(["http://127.0.0.1:54321", "http://localhost:54321"])(
    "allows a local URL outside production: %s",
    (url) => {
      vi.stubEnv("NODE_ENV", "development");
      setEnv(url, FAKE_KEY);
      expect(getSupabasePublicEnv().url).toBe(url);
    },
  );

  it.each(["http://127.0.0.1:54321", "http://localhost:54321"])(
    "rejects a local URL in production: %s",
    (url) => {
      vi.stubEnv("NODE_ENV", "production");
      setEnv(url, FAKE_KEY);
      expect(() => getSupabasePublicEnv()).toThrow(
        "SUPABASE_URL must not point to a local host in production",
      );
    },
  );

  it("never includes the provided values in error messages", () => {
    const secretLike = "sb_secret_DO_NOT_LEAK_fake_value_123";
    setEnv(FAKE_URL, secretLike);
    expect(errorMessage(() => getSupabasePublicEnv())).not.toContain(secretLike);

    const jwtLike = "eyJDO_NOT_LEAK.fake.value";
    setEnv(FAKE_URL, jwtLike);
    expect(errorMessage(() => getSupabasePublicEnv())).not.toContain(jwtLike);

    const urlWithCreds = "https://leakuser:leakpass@abcdefghijklmnopqrst.supabase.co";
    setEnv(urlWithCreds, FAKE_KEY);
    const message = errorMessage(() => getSupabasePublicEnv());
    expect(message).not.toContain("leakuser");
    expect(message).not.toContain("leakpass");

    setEnv("https://leak-host.example.com", FAKE_KEY);
    expect(errorMessage(() => getSupabasePublicEnv())).not.toContain("leak-host");
  });
});

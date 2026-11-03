import { beforeEach, describe, expect, it, vi } from "vitest";

// A cookie jar standing in for the browser: set() with maxAge 0 removes.
const jar = new Map<string, string>();
const setCalls: Array<{ name: string; value: string; options: Record<string, unknown> }> = [];
const cookieStore = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name) as string } : undefined),
  set: (name: string, value: string, options: Record<string, unknown>) => {
    setCalls.push({ name, value, options });
    if (options.maxAge === 0) jar.delete(name);
    else jar.set(name, value);
  },
};

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));

const { P6_DRAFT_COOKIE, clearP6Draft, p6DraftDigest, readP6Draft, saveP6Draft } = await import("./draft-cookie");

const DRAFT = { checkedAt: "2026-11-02T21:30", periodStart: "2026-11-02", "egress.value": "0.008", "egress.unit": "GB" };

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

// Every field at the 40-character limit: kept field by field, too large as a whole.
async function oversized(): Promise<Record<string, string>> {
  const { P6_FORM_FIELDS } = await import("@/lib/p6-usage-form");
  return Object.fromEntries(P6_FORM_FIELDS.map((name) => [name, "9".repeat(40)]));
}

beforeEach(() => {
  jar.clear();
  setCalls.length = 0;
});

describe("saveP6Draft", () => {
  it("keeps a normal draft, HttpOnly, SameSite=Strict, on /admin/usage, for 30 minutes", async () => {
    expect(await saveP6Draft(DRAFT)).toBe(true);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0].options).toMatchObject({ path: "/admin/usage", httpOnly: true, sameSite: "strict", maxAge: 1800 });
    expect(await readP6Draft()).toEqual(DRAFT);
  });

  it("keeps a full realistic draft, with a choice for every metric", async () => {
    const { P6_FORM_FIELDS } = await import("@/lib/p6-usage-form");
    const full = Object.fromEntries(
      P6_FORM_FIELDS.map((name) => [name, name.endsWith(".status") ? "unavailable" : name.endsWith(".unit") ? "GB" : "9,999,999,999.999"]),
    );
    expect(await saveP6Draft(full)).toBe(true);
    expect(await readP6Draft()).toEqual(full);
  });

  it("refuses a draft too large to keep and removes the earlier draft", async () => {
    await saveP6Draft(DRAFT);
    expect(await saveP6Draft(await oversized())).toBe(false);
    expect(setCalls.at(-1)).toMatchObject({ name: P6_DRAFT_COOKIE, value: "", options: { path: "/admin/usage", maxAge: 0 } });
    expect(jar.has(P6_DRAFT_COOKIE)).toBe(false);
    expect(await readP6Draft()).toBeNull();
  });
});

describe("readP6Draft", () => {
  it("returns null when there is no draft (never set, expired or cleared)", async () => {
    expect(await readP6Draft()).toBeNull();
    await saveP6Draft(DRAFT);
    await clearP6Draft();
    expect(await readP6Draft()).toBeNull();
  });

  it.each([
    ["not base64", "%%%not-base64%%%"],
    ["base64 of text that is not JSON", Buffer.from("{egress", "utf8").toString("base64url")],
    ["JSON null", encode(null)],
    ["a JSON array", encode(["egress.value", "1"])],
    ["a JSON string", encode("egress")],
    ["a cookie longer than the limit", "a".repeat(3501)],
  ])("refuses %s", async (_label, value) => {
    jar.set(P6_DRAFT_COOKIE, value);
    expect(await readP6Draft()).toBeNull();
  });

  it("keeps only known fields with short string values from a changed cookie", async () => {
    jar.set(P6_DRAFT_COOKIE, encode({ ...DRAFT, "egress.quota": 250, role: "admin", periodEnd: "x".repeat(41) }));
    expect(await readP6Draft()).toEqual(DRAFT);
  });
});

describe("p6DraftDigest", () => {
  it("is a SHA-256 hex digest that depends on the content, not on field order", () => {
    const digest = p6DraftDigest(DRAFT);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(p6DraftDigest(Object.fromEntries(Object.entries(DRAFT).reverse()))).toBe(digest);
  });

  it("changes with any field's text, and tells a missing field from an empty one", () => {
    const digest = p6DraftDigest(DRAFT);
    expect(p6DraftDigest({ ...DRAFT, "egress.value": "0.009" })).not.toBe(digest);
    expect(p6DraftDigest({ ...DRAFT, "egress.unit": "MB" })).not.toBe(digest);
    expect(p6DraftDigest({ ...DRAFT, dataAsOf: "" })).not.toBe(digest);
    expect(p6DraftDigest({})).not.toBe(p6DraftDigest({ dataAsOf: "" }));
  });

  it("ignores fields the draft never keeps", () => {
    expect(p6DraftDigest({ ...DRAFT, role: "admin" })).toBe(p6DraftDigest(DRAFT));
  });
});

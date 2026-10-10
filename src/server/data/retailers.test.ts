import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeResult } from "@/test/fake-postgrest";

const { getPublicSupabaseClient } = vi.hoisted(() => ({ getPublicSupabaseClient: vi.fn() }));
vi.mock("@/server/supabase/public-client", () => ({ getPublicSupabaseClient }));

const { listActiveRetailers } = await import("./retailers");
const { DataAccessError } = await import("./errors");

function useFake(result: FakeResult) {
  const fake = createFakeSupabase(result);
  getPublicSupabaseClient.mockReturnValue(fake.client);
  return fake;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  getPublicSupabaseClient.mockReset();
});

describe("listActiveRetailers", () => {
  it("queries active retailers with explicit columns and ordering", async () => {
    const fake = useFake({ data: [], error: null });

    await listActiveRetailers();

    expect(fake.tables).toEqual(["retailers"]);
    expect(fake.calls).toEqual([
      { method: "select", args: ["id, slug, name, official_base_url, sort_order"] },
      { method: "eq", args: ["is_active", true] },
      { method: "order", args: ["sort_order", { ascending: true }] },
      { method: "order", args: ["slug", { ascending: true }] },
    ]);
  });

  it("maps rows to DTOs without DB-only fields", async () => {
    useFake({
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          slug: "rakuten",
          name: "楽天市場",
          official_base_url: "https://www.rakuten.co.jp/",
          sort_order: 10,
          is_active: true,
          created_at: "2026-01-01T00:00:00+00:00",
        },
      ],
      error: null,
    });

    const result = await listActiveRetailers();

    expect(result).toEqual([
      {
        id: "11111111-1111-4111-8111-111111111111",
        slug: "rakuten",
        name: "楽天市場",
        officialBaseUrl: "https://www.rakuten.co.jp/",
        sortOrder: 10,
      },
    ]);
    expect(Object.keys(result[0]).sort()).toEqual([
      "id",
      "name",
      "officialBaseUrl",
      "slug",
      "sortOrder",
    ]);
  });

  it("converts Supabase errors to a generic DataAccessError", async () => {
    useFake({
      data: null,
      error: { code: "PGRST000", message: "connection to https://leak.example failed" },
    });

    const promise = listActiveRetailers();

    await expect(promise).rejects.toBeInstanceOf(DataAccessError);
    await expect(promise).rejects.toThrow("Failed to load retailers");
    await expect(promise).rejects.not.toThrow(/leak\.example|PGRST000/);
  });
});

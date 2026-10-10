import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeResult } from "@/test/fake-postgrest";

const { getPublicSupabaseClient } = vi.hoisted(() => ({ getPublicSupabaseClient: vi.fn() }));
vi.mock("@/server/supabase/public-client", () => ({ getPublicSupabaseClient }));

const { listPublishedSaleEvents, getPublishedSaleEvent } = await import("./sale-events");
const { DataAccessError, InvalidQueryError } = await import("./errors");

const EXPECTED_COLUMNS =
  "id, title, description, starts_at, ends_at, is_date_only, source_url, source_checked_at, published_at, retailers!inner(slug, name)";

const EVENT_ID = "22222222-2222-4222-8222-222222222222";

const ROW = {
  id: EVENT_ID,
  title: "スーパーSALE",
  description: null,
  starts_at: "2026-12-04T11:00:00+00:00",
  ends_at: "2026-12-11T02:00:00+00:00",
  is_date_only: false,
  source_url: "https://www.rakuten.co.jp/event/",
  source_checked_at: null,
  published_at: "2026-11-20T00:00:00+00:00",
  retailers: { slug: "rakuten", name: "楽天市場" },
};

const DTO = {
  id: EVENT_ID,
  title: "スーパーSALE",
  description: null,
  startsAt: "2026-12-04T11:00:00+00:00",
  endsAt: "2026-12-11T02:00:00+00:00",
  isDateOnly: false,
  sourceUrl: "https://www.rakuten.co.jp/event/",
  sourceCheckedAt: null,
  publishedAt: "2026-11-20T00:00:00+00:00",
  retailer: { slug: "rakuten", name: "楽天市場" },
};

const FROM = new Date("2026-12-01T00:00:00Z");
const TO = new Date("2027-01-01T00:00:00Z");

function useFake(result: FakeResult) {
  const fake = createFakeSupabase(result);
  getPublicSupabaseClient.mockReturnValue(fake.client);
  return fake;
}

function methods(calls: { method: string }[]) {
  return calls.map((call) => call.method);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  getPublicSupabaseClient.mockReset();
});

describe("listPublishedSaleEvents", () => {
  it("builds an overlap query for published events with explicit columns", async () => {
    const fake = useFake({ data: [], error: null });

    await listPublishedSaleEvents({ from: FROM, to: TO });

    expect(fake.tables).toEqual(["sale_events"]);
    expect(fake.calls).toEqual([
      { method: "select", args: [EXPECTED_COLUMNS] },
      { method: "eq", args: ["status", "published"] },
      { method: "lt", args: ["starts_at", TO.toISOString()] },
      { method: "gt", args: ["ends_at", FROM.toISOString()] },
      { method: "order", args: ["starts_at", { ascending: true }] },
      { method: "order", args: ["id", { ascending: true }] },
      { method: "limit", args: [500] },
      { method: "overrideTypes", args: [] },
    ]);
  });

  it("filters by retailer slug when given", async () => {
    const fake = useFake({ data: [], error: null });

    await listPublishedSaleEvents({ from: FROM, to: TO, retailerSlug: "qoo10" });

    expect(fake.calls).toContainEqual({ method: "eq", args: ["retailers.slug", "qoo10"] });
    expect(methods(fake.calls).slice(0, 5)).toEqual(["select", "eq", "lt", "gt", "eq"]);
  });

  it("maps rows to DTOs without DB-only fields", async () => {
    useFake({
      data: [{ ...ROW, status: "published", title_key: "x", start_date_jst: "2026-12-04" }],
      error: null,
    });

    const result = await listPublishedSaleEvents({ from: FROM, to: TO });

    expect(result).toEqual([DTO]);
    const keys = Object.keys(result[0]);
    for (const forbidden of [
      "status",
      "title_key",
      "titleKey",
      "start_date_jst",
      "startDateJst",
      "rejected_at",
      "archived_at",
      "created_at",
      "updated_at",
      "retailer_id",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  it.each([
    ["invalid from", { from: new Date("nope"), to: TO }],
    ["invalid to", { from: FROM, to: new Date("nope") }],
    ["from equals to", { from: FROM, to: FROM }],
    ["from after to", { from: TO, to: FROM }],
    [
      "range longer than 400 days",
      { from: FROM, to: new Date(FROM.getTime() + 401 * 24 * 60 * 60 * 1000) },
    ],
    ["uppercase slug", { from: FROM, to: TO, retailerSlug: "Rakuten" }],
    ["slug with symbols", { from: FROM, to: TO, retailerSlug: "rakuten,amazon" }],
    ["empty slug", { from: FROM, to: TO, retailerSlug: "" }],
    ["slug too long", { from: FROM, to: TO, retailerSlug: "a".repeat(65) }],
  ])("rejects %s without querying the database", async (_label, params) => {
    useFake({ data: [], error: null });

    await expect(listPublishedSaleEvents(params)).rejects.toBeInstanceOf(InvalidQueryError);
    expect(getPublicSupabaseClient).not.toHaveBeenCalled();
  });

  it("accepts exactly 400 days", async () => {
    useFake({ data: [], error: null });

    await expect(
      listPublishedSaleEvents({
        from: FROM,
        to: new Date(FROM.getTime() + 400 * 24 * 60 * 60 * 1000),
      }),
    ).resolves.toEqual([]);
  });

  it("converts Supabase errors to a generic DataAccessError", async () => {
    useFake({
      data: null,
      error: { code: "42501", message: "permission denied for table sale_events" },
    });

    const promise = listPublishedSaleEvents({ from: FROM, to: TO });

    await expect(promise).rejects.toBeInstanceOf(DataAccessError);
    await expect(promise).rejects.toThrow("Failed to load sale events");
    await expect(promise).rejects.not.toThrow(/permission denied|42501/);
  });

  it("fails safely when published_at is unexpectedly null", async () => {
    useFake({ data: [{ ...ROW, published_at: null }], error: null });

    await expect(listPublishedSaleEvents({ from: FROM, to: TO })).rejects.toBeInstanceOf(
      DataAccessError,
    );
  });
});

describe("getPublishedSaleEvent", () => {
  it("queries a single published event by id", async () => {
    const fake = useFake({ data: ROW, error: null });

    const result = await getPublishedSaleEvent(EVENT_ID);

    expect(result).toEqual(DTO);
    expect(fake.tables).toEqual(["sale_events"]);
    expect(fake.calls).toEqual([
      { method: "select", args: [EXPECTED_COLUMNS] },
      { method: "eq", args: ["id", EVENT_ID] },
      { method: "eq", args: ["status", "published"] },
      { method: "maybeSingle", args: [] },
      { method: "overrideTypes", args: [] },
    ]);
  });

  it.each(["", "not-a-uuid", "22222222-2222-4222-8222-22222222222", `${EVENT_ID}x`])(
    "returns null for an invalid id without querying: %s",
    async (id) => {
      useFake({ data: ROW, error: null });

      await expect(getPublishedSaleEvent(id)).resolves.toBeNull();
      expect(getPublicSupabaseClient).not.toHaveBeenCalled();
    },
  );

  it("returns null when no published event matches", async () => {
    useFake({ data: null, error: null });

    await expect(getPublishedSaleEvent(EVENT_ID)).resolves.toBeNull();
  });

  it("converts Supabase errors to a generic DataAccessError", async () => {
    useFake({ data: null, error: { code: "PGRST000", message: "upstream detail" } });

    const promise = getPublishedSaleEvent(EVENT_ID);

    await expect(promise).rejects.toBeInstanceOf(DataAccessError);
    await expect(promise).rejects.not.toThrow(/upstream detail|PGRST000/);
  });

  it("fails safely when published_at is unexpectedly null", async () => {
    useFake({ data: { ...ROW, published_at: null }, error: null });

    await expect(getPublishedSaleEvent(EVENT_ID)).rejects.toBeInstanceOf(DataAccessError);
  });
});

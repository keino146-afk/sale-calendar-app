import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeResult } from "@/test/fake-postgrest";

const { getPublicSupabaseClient } = vi.hoisted(() => ({ getPublicSupabaseClient: vi.fn() }));
vi.mock("@/server/supabase/public-client", () => ({ getPublicSupabaseClient }));

const {
  listPublishedSaleEvents,
  getNextPublishedSaleEvent,
  getPublishedSaleEvent,
  listSitemapSaleEvents,
  SITEMAP_SALE_LIMIT,
} = await import("./sale-events");
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

describe("getNextPublishedSaleEvent", () => {
  const AFTER = new Date("2026-10-24T03:00:00.000Z");

  it("asks for the earliest published event starting at or after the boundary", async () => {
    const fake = useFake({ data: [ROW], error: null });

    const result = await getNextPublishedSaleEvent({ after: AFTER });

    expect(result).toEqual(DTO);
    expect(fake.tables).toEqual(["sale_events"]);
    expect(fake.calls).toEqual([
      { method: "select", args: [EXPECTED_COLUMNS] },
      { method: "eq", args: ["status", "published"] },
      { method: "gte", args: ["starts_at", AFTER.toISOString()] },
      { method: "order", args: ["starts_at", { ascending: true }] },
      { method: "order", args: ["id", { ascending: true }] },
      { method: "limit", args: [1] },
      // A hint only: no automatic retries on failure.
      { method: "retry", args: [false] },
      { method: "overrideTypes", args: [] },
    ]);
  });

  it("filters by retailer slug when given", async () => {
    const fake = useFake({ data: [], error: null });

    await getNextPublishedSaleEvent({ after: AFTER, retailerSlug: "qoo10" });

    expect(fake.calls).toContainEqual({ method: "eq", args: ["retailers.slug", "qoo10"] });
    expect(methods(fake.calls).slice(0, 4)).toEqual(["select", "eq", "gte", "eq"]);
  });

  it("returns null when there is no later event", async () => {
    useFake({ data: [], error: null });

    await expect(getNextPublishedSaleEvent({ after: AFTER })).resolves.toBeNull();
  });

  it.each([
    ["an invalid date", { after: new Date("invalid") }],
    ["a non-date", { after: "2026-10-24" as unknown as Date }],
    ["a malformed retailer slug", { after: AFTER, retailerSlug: "Rakuten!" }],
  ])("rejects %s without querying", async (_label, params) => {
    const fake = useFake({ data: [], error: null });

    await expect(getNextPublishedSaleEvent(params)).rejects.toBeInstanceOf(InvalidQueryError);
    expect(fake.tables).toEqual([]);
  });

  it("converts Supabase errors to a generic DataAccessError", async () => {
    useFake({ data: null, error: { code: "42501", message: "permission denied for table sale_events" } });

    const promise = getNextPublishedSaleEvent({ after: AFTER });

    await expect(promise).rejects.toBeInstanceOf(DataAccessError);
    await expect(promise).rejects.not.toThrow(/permission denied|42501/);
  });

  it("fails safely when published_at is unexpectedly null", async () => {
    useFake({ data: [{ ...ROW, published_at: null }], error: null });

    await expect(getNextPublishedSaleEvent({ after: AFTER })).rejects.toBeInstanceOf(DataAccessError);
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

describe("listSitemapSaleEvents", () => {
  const NOW = new Date("2026-10-16T03:00:00.000Z");

  it("asks only for published sales that have not ended, in a fixed order, with a limit", async () => {
    const fake = useFake({
      data: [{ id: EVENT_ID, updated_at: "2026-11-20T00:00:00.123456+00:00" }],
      error: null,
    });

    expect(await listSitemapSaleEvents({ now: NOW })).toEqual([
      { id: EVENT_ID, updatedAt: "2026-11-20T00:00:00.123456+00:00" },
    ]);
    expect(fake.tables).toEqual(["sale_events"]);
    expect(fake.calls).toEqual([
      { method: "select", args: ["id, updated_at"] },
      { method: "eq", args: ["status", "published"] },
      { method: "gt", args: ["ends_at", NOW.toISOString()] },
      { method: "order", args: ["starts_at", { ascending: true }] },
      { method: "order", args: ["id", { ascending: true }] },
      { method: "limit", args: [1000] },
      { method: "overrideTypes", args: [] },
    ]);
    expect(SITEMAP_SALE_LIMIT).toBe(1000);
  });

  it("rejects an invalid date without querying", async () => {
    const fake = useFake({ data: [], error: null });

    await expect(listSitemapSaleEvents({ now: new Date("invalid") })).rejects.toBeInstanceOf(InvalidQueryError);
    expect(fake.tables).toEqual([]);
  });

  it("converts Supabase errors to a generic DataAccessError", async () => {
    useFake({ data: null, error: { code: "42501", message: "permission denied for table sale_events" } });

    const promise = listSitemapSaleEvents({ now: NOW });

    await expect(promise).rejects.toBeInstanceOf(DataAccessError);
    await expect(promise).rejects.not.toThrow(/permission denied|42501/);
  });
});

describe("automatic retries", () => {
  // postgrest-js retries 503/520 and network errors (up to 3 times). Only the
  // optional next-sale hint opts out; every primary public read keeps them.
  it.each([
    ["listPublishedSaleEvents", () => listPublishedSaleEvents({ from: FROM, to: TO }), []],
    ["getPublishedSaleEvent", () => getPublishedSaleEvent(EVENT_ID), null],
    ["listSitemapSaleEvents", () => listSitemapSaleEvents({ now: FROM }), []],
  ] as const)("keeps retries for %s", async (_label, read, data) => {
    const fake = useFake({ data, error: null });

    await read();

    expect(methods(fake.calls)).not.toContain("retry");
  });

  it("turns them off only for the next-sale hint", async () => {
    const fake = useFake({ data: [], error: null });

    await getNextPublishedSaleEvent({ after: FROM });

    expect(fake.calls.filter((call) => call.method === "retry")).toEqual([{ method: "retry", args: [false] }]);
  });

  it("treats an aborted (timed-out) request as a failure, never as an empty result", async () => {
    // postgrest-js turns an abort into an error result like this one.
    const aborted = {
      data: null,
      error: { code: "", message: "AbortError: This operation was aborted" },
    };

    useFake(aborted);
    await expect(listPublishedSaleEvents({ from: FROM, to: TO })).rejects.toBeInstanceOf(DataAccessError);
    useFake(aborted);
    await expect(getNextPublishedSaleEvent({ after: FROM })).rejects.toBeInstanceOf(DataAccessError);
    useFake(aborted);
    await expect(listSitemapSaleEvents({ now: FROM })).rejects.toBeInstanceOf(DataAccessError);
  });
});

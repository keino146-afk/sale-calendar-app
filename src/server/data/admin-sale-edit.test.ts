import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeResult } from "@/test/fake-postgrest";

const { getAdminSaleEventForEdit, updateSaleEvent } = await import("./admin-sale-edit");
const { DataAccessError } = await import("./errors");

const EXPECTED_COLUMNS =
  "id, status, title, description, starts_at, ends_at, is_date_only, source_url, source_checked_at, updated_at, retailers!inner(id, slug, name, official_base_url)";

const SALE_ID = "33333333-3333-4333-8333-333333333333";
const RETAILER_ID = "11111111-1111-4111-8111-111111111111";
// Microsecond precision, exactly as PostgREST returns it.
const UPDATED_AT = "2026-10-14T03:04:05.123456+00:00";

const ROW = {
  id: SALE_ID,
  status: "published",
  title: "スーパーSALE",
  description: null,
  starts_at: "2026-12-04T11:00:00+00:00",
  ends_at: "2026-12-11T02:00:00+00:00",
  is_date_only: false,
  source_url: "https://www.rakuten.co.jp/event/",
  source_checked_at: "2026-11-01T00:00:00+00:00",
  updated_at: UPDATED_AT,
  retailers: { id: RETAILER_ID, slug: "rakuten", name: "楽天市場", official_base_url: "https://www.rakuten.co.jp/" },
};

const CONTENT = {
  title: "スーパーSALE",
  description: null,
  startsAt: new Date("2026-12-04T11:00:00Z"),
  endsAt: new Date("2026-12-11T01:00:00Z"),
  isDateOnly: false,
  sourceUrl: "https://www.rakuten.co.jp/event/",
  sourceCheckedAt: new Date("2026-11-02T00:00:00Z"),
};

function client(value: unknown) {
  return value as never;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getAdminSaleEventForEdit", () => {
  it("reads the editable fields, the exact updated_at and the retailer's official domain", async () => {
    const f = createFakeSupabase({ data: ROW, error: null });

    expect(await getAdminSaleEventForEdit(client(f.client), SALE_ID)).toEqual({
      id: SALE_ID,
      status: "published",
      title: "スーパーSALE",
      description: null,
      startsAt: ROW.starts_at,
      endsAt: ROW.ends_at,
      isDateOnly: false,
      sourceUrl: ROW.source_url,
      sourceCheckedAt: ROW.source_checked_at,
      updatedAt: UPDATED_AT,
      retailer: { id: RETAILER_ID, slug: "rakuten", name: "楽天市場", officialBaseUrl: "https://www.rakuten.co.jp/" },
    });
    expect(f.tables).toEqual(["sale_events"]);
    expect(f.calls).toEqual([
      { method: "select", args: [EXPECTED_COLUMNS] },
      { method: "eq", args: ["id", SALE_ID] },
      { method: "abortSignal", args: [expect.any(AbortSignal)] },
      { method: "maybeSingle", args: [] },
      { method: "overrideTypes", args: [] },
    ]);
  });

  it("returns null for a missing row and for a malformed id without querying", async () => {
    const missing = createFakeSupabase({ data: null, error: null });
    expect(await getAdminSaleEventForEdit(client(missing.client), SALE_ID)).toBeNull();

    const malformed = createFakeSupabase({ data: ROW, error: null });
    expect(await getAdminSaleEventForEdit(client(malformed.client), "not-a-uuid")).toBeNull();
    expect(malformed.tables).toEqual([]);
  });

  it.each([
    ["a database error", { data: null, error: { code: "PGRST000", message: "secret detail" } }],
    ["an unknown status", { data: { ...ROW, status: "deleted" }, error: null }],
    ["a missing retailer", { data: { ...ROW, retailers: null }, error: null }],
  ] as [string, FakeResult][])("throws a generic error for %s", async (_label, result) => {
    const f = createFakeSupabase(result);
    await expect(getAdminSaleEventForEdit(client(f.client), SALE_ID)).rejects.toBeInstanceOf(DataAccessError);
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret detail");
  });
});

describe("updateSaleEvent", () => {
  it("calls only update_sale_event with the content, the expected version and the confirmation", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    expect(
      await updateSaleEvent(client({ rpc }), {
        id: SALE_ID,
        expectedUpdatedAt: UPDATED_AT,
        publishedConfirmed: true,
        content: CONTENT,
      }),
    ).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("update_sale_event", {
      p_id: SALE_ID,
      p_expected_updated_at: UPDATED_AT,
      p_published_confirmed: true,
      p_title: "スーパーSALE",
      p_description: null,
      p_starts_at: "2026-12-04T11:00:00.000Z",
      p_ends_at: "2026-12-11T01:00:00.000Z",
      p_is_date_only: false,
      p_source_url: "https://www.rakuten.co.jp/event/",
      p_source_checked_at: "2026-11-02T00:00:00.000Z",
    });
    // Neither a status nor a retailer is ever sent.
    expect(Object.keys(rpc.mock.calls[0][1])).not.toEqual(expect.arrayContaining(["p_status"]));
    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain("p_retailer_id");
  });

  it.each([
    ["23505", "duplicate"],
    ["40001", "stale"],
    ["55000", "not_editable"],
    ["P0002", "not_found"],
    ["22023", "invalid_input"],
    ["42501", "failed"],
    [undefined, "failed"],
  ])("maps database code %s to %s without passing the message on", async (code, reason) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { code, message: "secret detail" } });

    expect(
      await updateSaleEvent(client({ rpc }), {
        id: SALE_ID,
        expectedUpdatedAt: UPDATED_AT,
        publishedConfirmed: false,
        content: CONTENT,
      }),
    ).toEqual({ ok: false, reason });
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("secret detail");
  });

  it("reports a thrown client error as failed", async () => {
    const rpc = vi.fn().mockRejectedValue(new Error("network"));

    expect(
      await updateSaleEvent(client({ rpc }), {
        id: SALE_ID,
        expectedUpdatedAt: UPDATED_AT,
        publishedConfirmed: false,
        content: CONTENT,
      }),
    ).toEqual({ ok: false, reason: "failed" });
  });
});

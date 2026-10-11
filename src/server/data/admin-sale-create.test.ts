import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeResult } from "@/test/fake-postgrest";

const { listActiveRetailersForAdmin, getActiveRetailerForAdmin, createSaleCandidate } = await import(
  "./admin-sale-create"
);
const { DataAccessError } = await import("./errors");

const RETAILER_ID = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "44444444-4444-4444-8444-444444444444";

const INPUT = {
  retailerId: RETAILER_ID,
  title: "スーパーSALE",
  description: null,
  startsAt: new Date("2026-10-10T15:00:00.000Z"),
  endsAt: new Date("2026-10-13T15:00:00.000Z"),
  isDateOnly: true,
  sourceUrl: "https://www.rakuten.co.jp/event/",
  sourceCheckedAt: new Date("2026-10-11T00:30:00.000Z"),
};

function fake(result: FakeResult) {
  return createFakeSupabase(result);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listActiveRetailersForAdmin", () => {
  it("reads active retailers only, in display order", async () => {
    const f = fake({
      data: [{ id: RETAILER_ID, slug: "rakuten", name: "楽天市場", official_base_url: "https://www.rakuten.co.jp/" }],
      error: null,
    });

    expect(await listActiveRetailersForAdmin(f.client as never)).toEqual([
      { id: RETAILER_ID, slug: "rakuten", name: "楽天市場", officialBaseUrl: "https://www.rakuten.co.jp/" },
    ]);
    expect(f.tables).toEqual(["retailers"]);
    expect(f.calls).toContainEqual({ method: "eq", args: ["is_active", true] });
    expect(f.calls).toContainEqual({ method: "order", args: ["sort_order", { ascending: true }] });
  });

  it("throws a generic error on failure", async () => {
    await expect(listActiveRetailersForAdmin(fake({ data: null, error: { code: "42501" } }).client as never)).rejects.toBeInstanceOf(
      DataAccessError,
    );
  });
});

describe("getActiveRetailerForAdmin", () => {
  it("looks the retailer up by id and requires it to be active", async () => {
    const f = fake({ data: null, error: null });

    expect(await getActiveRetailerForAdmin(f.client as never, RETAILER_ID)).toBeNull();
    expect(f.calls).toContainEqual({ method: "eq", args: ["id", RETAILER_ID] });
    expect(f.calls).toContainEqual({ method: "eq", args: ["is_active", true] });
  });
});

describe("createSaleCandidate", () => {
  it("inserts exactly the 8 granted columns and never a status", async () => {
    const f = fake({ data: { id: NEW_ID }, error: null });

    expect(await createSaleCandidate(f.client as never, INPUT)).toEqual({ ok: true, id: NEW_ID });
    expect(f.tables).toEqual(["sale_events"]);
    const insert = f.calls.find((call) => call.method === "insert");
    expect(insert?.args).toEqual([
      {
        retailer_id: RETAILER_ID,
        title: "スーパーSALE",
        description: null,
        starts_at: "2026-10-10T15:00:00.000Z",
        ends_at: "2026-10-13T15:00:00.000Z",
        is_date_only: true,
        source_url: "https://www.rakuten.co.jp/event/",
        source_checked_at: "2026-10-11T00:30:00.000Z",
      },
    ]);
    const columns = Object.keys((insert?.args[0] ?? {}) as object).sort();
    expect(columns).toEqual(
      ["description", "ends_at", "is_date_only", "retailer_id", "source_checked_at", "source_url", "starts_at", "title"],
    );
    expect(f.calls.map((call) => call.method)).toEqual(["insert", "select", "single"]);
    expect(f.calls[1]).toEqual({ method: "select", args: ["id"] });
  });

  it("reports a duplicate (23505) without exposing details", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fake({
      data: null,
      error: { code: "23505", message: 'duplicate key value violates unique constraint "sale_events_active_dedup_uidx"' },
    });

    expect(await createSaleCandidate(f.client as never, INPUT)).toEqual({ ok: false, reason: "duplicate" });
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("23505");
    expect(logged).not.toContain("sale_events_active_dedup_uidx");
    expect(logged).not.toContain("スーパーSALE");
  });

  it("reports other failures generically", async () => {
    for (const code of ["42501", "23514", "PGRST000"]) {
      const f = fake({ data: null, error: { code, message: "detail" } });
      expect(await createSaleCandidate(f.client as never, INPUT)).toEqual({ ok: false, reason: "failed" });
    }
  });
});

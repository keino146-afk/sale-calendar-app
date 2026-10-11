import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeResult } from "@/test/fake-postgrest";

const { listAdminSaleEvents, countPendingSaleEvents, getAdminSaleEvent, getLatestRejectReason, ADMIN_LIST_LIMIT } =
  await import("./admin-sale-events");
const { DataAccessError } = await import("./errors");

const EXPECTED_COLUMNS =
  "id, title, description, starts_at, ends_at, is_date_only, status, source_url, source_checked_at, published_at, rejected_at, archived_at, retailers!inner(slug, name)";

const SALE_ID = "33333333-3333-4333-8333-333333333333";

const ROW = {
  id: SALE_ID,
  title: "候補セール",
  description: "説明",
  starts_at: "2026-12-04T11:00:00+00:00",
  ends_at: "2026-12-11T02:00:00+00:00",
  is_date_only: false,
  status: "pending_review",
  source_url: "https://www.rakuten.co.jp/event/",
  source_checked_at: "2026-11-01T00:00:00+00:00",
  published_at: null,
  rejected_at: null,
  archived_at: null,
  retailers: { slug: "rakuten", name: "楽天市場" },
};

const DTO = {
  id: SALE_ID,
  title: "候補セール",
  description: "説明",
  startsAt: "2026-12-04T11:00:00+00:00",
  endsAt: "2026-12-11T02:00:00+00:00",
  isDateOnly: false,
  status: "pending_review",
  sourceUrl: "https://www.rakuten.co.jp/event/",
  sourceCheckedAt: "2026-11-01T00:00:00+00:00",
  publishedAt: null,
  rejectedAt: null,
  archivedAt: null,
  retailer: { slug: "rakuten", name: "楽天市場" },
};

function fake(result: FakeResult) {
  return createFakeSupabase(result);
}

function client(f: ReturnType<typeof fake>) {
  return f.client as never;
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listAdminSaleEvents", () => {
  it("reads one status with a bounded, ordered query and maps to DTOs", async () => {
    const f = fake({ data: [ROW], error: null });

    expect(await listAdminSaleEvents(client(f), { status: "pending_review" })).toEqual([DTO]);
    expect(f.tables).toEqual(["sale_events"]);
    expect(f.calls).toEqual([
      { method: "select", args: [EXPECTED_COLUMNS] },
      { method: "eq", args: ["status", "pending_review"] },
      { method: "order", args: ["created_at", { ascending: false }] },
      { method: "order", args: ["id", { ascending: true }] },
      { method: "limit", args: [ADMIN_LIST_LIMIT] },
      { method: "overrideTypes", args: [] },
    ]);
    expect(ADMIN_LIST_LIMIT).toBe(100);
  });

  it.each([
    ["published", "published_at"],
    ["rejected", "rejected_at"],
    ["archived", "archived_at"],
  ] as const)("orders %s by %s, newest first", async (status, column) => {
    const f = fake({ data: [], error: null });

    await listAdminSaleEvents(client(f), { status });

    expect(f.calls).toContainEqual({ method: "eq", args: ["status", status] });
    expect(f.calls.filter((call) => call.method === "order")[0]).toEqual({
      method: "order",
      args: [column, { ascending: false }],
    });
  });

  it("selects no internal columns", async () => {
    const f = fake({ data: [], error: null });

    await listAdminSaleEvents(client(f), { status: "published" });

    const select = String(f.calls[0].args[0]);
    for (const internal of ["title_key", "start_date_jst", "created_at", "updated_at", "retailer_id", "*"]) {
      expect(select).not.toContain(internal);
    }
  });

  it("throws a generic error and logs only the error code", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const f = fake({ data: null, error: { code: "42501", message: "permission denied for table secret_detail" } });

    await expect(listAdminSaleEvents(client(f), { status: "pending_review" })).rejects.toBeInstanceOf(
      DataAccessError,
    );
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("42501");
    expect(logged).not.toContain("secret_detail");
  });

  it("rejects rows with an unexpected status or missing retailer", async () => {
    await expect(
      listAdminSaleEvents(client(fake({ data: [{ ...ROW, status: "deleted" }], error: null })), {
        status: "pending_review",
      }),
    ).rejects.toBeInstanceOf(DataAccessError);
    await expect(
      listAdminSaleEvents(client(fake({ data: [{ ...ROW, retailers: null }], error: null })), {
        status: "pending_review",
      }),
    ).rejects.toBeInstanceOf(DataAccessError);
  });
});

describe("countPendingSaleEvents", () => {
  it("counts pending rows with a head-only exact count", async () => {
    const f = fake({ data: null, error: null, count: 3 });

    expect(await countPendingSaleEvents(client(f))).toBe(3);
    expect(f.calls).toEqual([
      { method: "select", args: ["id", { count: "exact", head: true }] },
      { method: "eq", args: ["status", "pending_review"] },
    ]);
  });

  it("throws on error or a missing count", async () => {
    await expect(countPendingSaleEvents(client(fake({ data: null, error: { code: "x" } })))).rejects.toBeInstanceOf(
      DataAccessError,
    );
    await expect(countPendingSaleEvents(client(fake({ data: null, error: null, count: null })))).rejects.toBeInstanceOf(
      DataAccessError,
    );
  });
});

describe("getAdminSaleEvent", () => {
  it("reads one sale of any status by id", async () => {
    const f = fake({ data: { ...ROW, status: "rejected", rejected_at: "2026-11-02T00:00:00+00:00" }, error: null });

    expect(await getAdminSaleEvent(client(f), SALE_ID)).toEqual({
      ...DTO,
      status: "rejected",
      rejectedAt: "2026-11-02T00:00:00+00:00",
    });
    expect(f.calls).toEqual([
      { method: "select", args: [EXPECTED_COLUMNS] },
      { method: "eq", args: ["id", SALE_ID] },
      { method: "maybeSingle", args: [] },
      { method: "overrideTypes", args: [] },
    ]);
    expect(f.calls.some((call) => call.method === "eq" && call.args[0] === "status")).toBe(false);
  });

  it("returns null for a missing sale", async () => {
    expect(await getAdminSaleEvent(client(fake({ data: null, error: null })), SALE_ID)).toBeNull();
  });

  it.each(["not-a-uuid", "", "33333333-3333-4333-8333-33333333333", `${SALE_ID}x`])(
    "returns null without querying for %j",
    async (id) => {
      const f = fake({ data: ROW, error: null });

      expect(await getAdminSaleEvent(client(f), id)).toBeNull();
      expect(f.tables).toEqual([]);
    },
  );

  it("throws a generic error on failure", async () => {
    await expect(
      getAdminSaleEvent(client(fake({ data: null, error: { code: "PGRST000" } })), SALE_ID),
    ).rejects.toBeInstanceOf(DataAccessError);
  });
});

describe("getLatestRejectReason", () => {
  it("reads only the note of the newest reject audit entry", async () => {
    const f = fake({ data: { note: "期間が誤り" }, error: null });

    expect(await getLatestRejectReason(client(f), SALE_ID)).toBe("期間が誤り");
    expect(f.tables).toEqual(["sale_event_audit"]);
    expect(f.calls).toEqual([
      { method: "select", args: ["note"] },
      { method: "eq", args: ["sale_event_id", SALE_ID] },
      { method: "eq", args: ["action", "reject"] },
      { method: "order", args: ["created_at", { ascending: false }] },
      { method: "order", args: ["id", { ascending: false }] },
      { method: "limit", args: [1] },
      { method: "maybeSingle", args: [] },
      { method: "overrideTypes", args: [] },
    ]);
  });

  it("returns null when there is no reject entry", async () => {
    expect(await getLatestRejectReason(client(fake({ data: null, error: null })), SALE_ID)).toBeNull();
  });

  it("does not query for a malformed id", async () => {
    const f = fake({ data: { note: "x" }, error: null });
    expect(await getLatestRejectReason(client(f), "nope")).toBeNull();
    expect(f.tables).toEqual([]);
  });

  it("throws a generic error on failure", async () => {
    await expect(
      getLatestRejectReason(client(fake({ data: null, error: { code: "42501" } })), SALE_ID),
    ).rejects.toBeInstanceOf(DataAccessError);
  });
});

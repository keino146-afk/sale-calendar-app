import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase, type FakeResult } from "@/test/fake-postgrest";

const {
  listCollectionCandidates,
  getCollectionCandidate,
  isCandidateId,
  parseCandidateReviewState,
  CANDIDATE_LIST_LIMIT,
} = await import("./admin-collection-candidates");
const { DataAccessError } = await import("./errors");

const ID = "55555555-5555-4555-8555-555555555555";
const RETAILER = { id: "22222222-2222-4222-8222-222222222222", slug: "amazon", name: "Amazon" };

const ROW = {
  id: ID,
  title: "プライム感謝祭",
  starts_at: "2026-10-15T15:00:00+00:00",
  ends_at: "2026-10-19T14:59:00+00:00",
  is_date_only: false,
  review_state: "new",
  source_changed: false,
  first_seen_at: "2026-10-01T00:00:00+00:00",
  last_seen_at: "2026-10-02T00:00:00+00:00",
  retailers: RETAILER,
};

const DETAIL_ROW = {
  ...ROW,
  description: null,
  source_url: "https://www.aboutamazon.jp/news/prime",
  source_checked_at: "2026-10-02T00:00:00+00:00",
  evidence_excerpt: "プライム感謝祭を開催",
  parser_version: "amazon-rss-1",
  imported_sale_event_id: null,
};

const fake = (result: FakeResult) => createFakeSupabase(result);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listCollectionCandidates", () => {
  it("reads one review state, newest sighting first, bounded, without hashes", async () => {
    const f = fake({ data: [ROW], error: null });

    expect(await listCollectionCandidates(f.client as never, { reviewState: "new" })).toEqual([
      {
        id: ID,
        title: "プライム感謝祭",
        startsAt: ROW.starts_at,
        endsAt: ROW.ends_at,
        isDateOnly: false,
        reviewState: "new",
        sourceChanged: false,
        firstSeenAt: ROW.first_seen_at,
        lastSeenAt: ROW.last_seen_at,
        retailer: RETAILER,
      },
    ]);
    expect(f.tables).toEqual(["collection_candidates"]);
    const select = String(f.calls[0].args[0]);
    expect(select).not.toMatch(/hash|\*/);
    expect(f.calls).toContainEqual({ method: "eq", args: ["review_state", "new"] });
    expect(f.calls).toContainEqual({ method: "order", args: ["last_seen_at", { ascending: false }] });
    expect(f.calls).toContainEqual({ method: "limit", args: [CANDIDATE_LIST_LIMIT] });
    expect(f.calls).toContainEqual({ method: "abortSignal", args: [expect.any(AbortSignal)] });
    expect(CANDIDATE_LIST_LIMIT).toBe(100);
    expect(f.calls.map((call) => call.method)).not.toContain("insert");
  });

  it("throws a generic error and logs only the code", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      listCollectionCandidates(fake({ data: null, error: { code: "42501", message: "secret_detail" } }).client as never, {
        reviewState: "new",
      }),
    ).rejects.toBeInstanceOf(DataAccessError);
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("42501");
    expect(logged).not.toContain("secret_detail");
  });
});

describe("getCollectionCandidate", () => {
  it("reads one candidate with review details but no hashes", async () => {
    const f = fake({ data: DETAIL_ROW, error: null });

    expect(await getCollectionCandidate(f.client as never, ID)).toMatchObject({
      id: ID,
      sourceUrl: DETAIL_ROW.source_url,
      sourceCheckedAt: DETAIL_ROW.source_checked_at,
      evidenceExcerpt: "プライム感謝祭を開催",
      parserVersion: "amazon-rss-1",
      description: null,
      importedSaleEventId: null,
    });
    expect(String(f.calls[0].args[0])).not.toMatch(/hash/);
    expect(f.calls).toContainEqual({ method: "eq", args: ["id", ID] });
    expect(f.calls).toContainEqual({ method: "abortSignal", args: [expect.any(AbortSignal)] });
  });

  it("exposes the linked sale of an imported candidate only as a valid id", async () => {
    const saleId = "77777777-7777-4777-8777-777777777777";
    const linked = fake({ data: { ...DETAIL_ROW, review_state: "imported", imported_sale_event_id: saleId }, error: null });
    expect(await getCollectionCandidate(linked.client as never, ID)).toMatchObject({ reviewState: "imported", importedSaleEventId: saleId });
    const odd = fake({ data: { ...DETAIL_ROW, review_state: "imported", imported_sale_event_id: "../x" }, error: null });
    expect(await getCollectionCandidate(odd.client as never, ID)).toMatchObject({ importedSaleEventId: null });
  });

  it("returns null for a missing candidate", async () => {
    expect(await getCollectionCandidate(fake({ data: null, error: null }).client as never, ID)).toBeNull();
  });

  it.each(["", "not-a-uuid", `${ID}x`, "../../x"])("does not query for id %j", async (id) => {
    const f = fake({ data: DETAIL_ROW, error: null });
    expect(await getCollectionCandidate(f.client as never, id)).toBeNull();
    expect(f.tables).toEqual([]);
  });
});

describe("helpers", () => {
  it("validates ids and review states", () => {
    expect(isCandidateId(ID)).toBe(true);
    expect(isCandidateId([ID])).toBe(false);
    expect(parseCandidateReviewState("imported")).toBe("imported");
    for (const value of [undefined, "published", ["new", "new"], ""]) {
      expect(parseCandidateReviewState(value)).toBe("new");
    }
  });
});

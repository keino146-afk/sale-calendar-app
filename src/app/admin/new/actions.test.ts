import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RedirectSentinel extends Error {
    constructor(public readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return {
    isSameOriginRequest: vi.fn(),
    requireAdmin: vi.fn(),
    getActiveRetailerForAdmin: vi.fn(),
    createSaleCandidate: vi.fn(),
    rpc: vi.fn(),
    importRpc: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new RedirectSentinel(url);
    }),
    REDIRECT: RedirectSentinel,
  };
});

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth/admin-auth", () => ({ isSameOriginRequest: mocks.isSameOriginRequest }));
vi.mock("@/server/auth/admin-session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/server/data/admin-sale-create", () => ({
  getActiveRetailerForAdmin: mocks.getActiveRetailerForAdmin,
  createSaleCandidate: mocks.createSaleCandidate,
}));

const { createSaleCandidateAction } = await import("./actions");

const CLIENT = { fake: "admin client", rpc: mocks.rpc };
const RETAILER_ID = "11111111-1111-4111-8111-111111111111";
const AMAZON_ID = "22222222-2222-4222-8222-222222222222";
const QOO10_ID = "33333333-3333-4333-8333-333333333333";
const NEW_ID = "44444444-4444-4444-8444-444444444444";
const RETAILER = { id: RETAILER_ID, slug: "rakuten", name: "楽天市場", officialBaseUrl: "https://www.rakuten.co.jp/" };
const AMAZON = { id: AMAZON_ID, slug: "amazon", name: "Amazon", officialBaseUrl: "https://www.amazon.co.jp/" };
const QOO10 = { id: QOO10_ID, slug: "qoo10", name: "Qoo10", officialBaseUrl: "https://www.qoo10.jp/" };
const ABOUTAMAZON_ARTICLE = "https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026";
const CANDIDATE_ID = "55555555-5555-4555-8555-555555555555";
const IMPORTED_ID = "66666666-6666-4666-8666-666666666666";

// Stand-in for public.is_allowed_manual_source with the seeded Amazon policy
// (the real function is covered by the pgTAP tests).
function policyRpc(name: string, args: { p_retailer_id: string; p_hostname: string; p_source_url: string }) {
  expect(name).toBe("is_allowed_manual_source");
  const allowed =
    args.p_retailer_id === AMAZON_ID &&
    args.p_hostname === "www.aboutamazon.jp" &&
    /^https:\/\/www\.aboutamazon\.jp\/news\/[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/.test(args.p_source_url);
  return Promise.resolve({ data: allowed, error: null });
}

// The admin client's rpc(): the source policy check or the atomic import.
function fakeRpc(name: string, args: Record<string, unknown>) {
  if (name === "import_collection_candidate") return mocks.importRpc(args);
  return policyRpc(name, args as Parameters<typeof policyRpc>[1]);
}

const VALID = {
  mode: "date",
  retailerId: RETAILER_ID,
  title: "【Phase4Dテスト】手動登録確認",
  description: "説明",
  startDate: "2026-10-11",
  endDate: "2026-10-13",
  sourceUrl: "https://www.rakuten.co.jp/",
  sourceCheckedAt: "2026-10-11T09:30",
};

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function redirectUrl(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof mocks.REDIRECT) return error.url;
    throw error;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  mocks.isSameOriginRequest.mockResolvedValue(true);
  mocks.requireAdmin.mockResolvedValue(CLIENT);
  mocks.getActiveRetailerForAdmin.mockResolvedValue(RETAILER);
  mocks.createSaleCandidate.mockResolvedValue({ ok: true, id: NEW_ID });
  mocks.rpc.mockImplementation(fakeRpc);
  mocks.importRpc.mockResolvedValue({ data: IMPORTED_ID, error: null });
});

afterEach(() => {
  for (const mock of [
    mocks.isSameOriginRequest,
    mocks.requireAdmin,
    mocks.getActiveRetailerForAdmin,
    mocks.createSaleCandidate,
    mocks.rpc,
    mocks.importRpc,
  ]) {
    mock.mockReset();
  }
  mocks.redirect.mockClear();
});

describe("createSaleCandidateAction guards", () => {
  it("rejects a missing or foreign Origin before the session check", async () => {
    mocks.isSameOriginRequest.mockResolvedValue(false);

    expect(await redirectUrl(createSaleCandidateAction(form(VALID)))).toBe("/admin");
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", "/admin/login"],
    ["non-admin", "/admin/login?error=1"],
  ])("never inserts for an %s visitor", async (_label, url) => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect(url));

    expect(await redirectUrl(createSaleCandidateAction(form(VALID)))).toBe(url);
    expect(mocks.getActiveRetailerForAdmin).not.toHaveBeenCalled();
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });

  it("checks Origin, then admin, then the retailer, then inserts", async () => {
    const order: string[] = [];
    mocks.isSameOriginRequest.mockImplementation(async () => (order.push("origin"), true));
    mocks.requireAdmin.mockImplementation(async () => (order.push("admin"), CLIENT));
    mocks.getActiveRetailerForAdmin.mockImplementation(async () => (order.push("retailer"), RETAILER));
    mocks.createSaleCandidate.mockImplementation(async () => (order.push("insert"), { ok: true, id: NEW_ID }));

    await redirectUrl(createSaleCandidateAction(form(VALID)));

    expect(order).toEqual(["origin", "admin", "retailer", "insert"]);
  });
});

describe("createSaleCandidateAction", () => {
  it("creates a date-only candidate and opens its detail page", async () => {
    expect(await redirectUrl(createSaleCandidateAction(form(VALID)))).toBe(`/admin/sales/${NEW_ID}?done=created`);
    expect(mocks.getActiveRetailerForAdmin).toHaveBeenCalledWith(CLIENT, RETAILER_ID);
    expect(mocks.createSaleCandidate).toHaveBeenCalledWith(CLIENT, {
      retailerId: RETAILER_ID,
      title: "【Phase4Dテスト】手動登録確認",
      description: "説明",
      startsAt: new Date("2026-10-10T15:00:00.000Z"),
      endsAt: new Date("2026-10-13T15:00:00.000Z"),
      isDateOnly: true,
      sourceUrl: "https://www.rakuten.co.jp/",
      sourceCheckedAt: new Date("2026-10-11T00:30:00.000Z"),
    });
  });

  it("creates a timed candidate in datetime mode", async () => {
    await redirectUrl(
      createSaleCandidateAction(
        form({ ...VALID, mode: "datetime", startsAt: "2026-11-04T20:00", endsAt: "2026-11-11T01:59" }),
      ),
    );
    expect(mocks.createSaleCandidate.mock.calls[0][1]).toMatchObject({
      startsAt: new Date("2026-11-04T11:00:00.000Z"),
      endsAt: new Date("2026-11-10T16:59:00.000Z"),
      isDateOnly: false,
    });
  });

  it("never passes a status or internal field from the form", async () => {
    await redirectUrl(
      createSaleCandidateAction(
        form({ ...VALID, status: "published", title_key: "x", start_date_jst: "2026-01-01", published_at: "x" }),
      ),
    );
    const input = mocks.createSaleCandidate.mock.calls[0][1] as Record<string, unknown>;
    expect(Object.keys(input).sort()).toEqual(
      ["description", "endsAt", "isDateOnly", "retailerId", "sourceCheckedAt", "sourceUrl", "startsAt", "title"],
    );
  });

  it.each([
    ["title", { title: " " }],
    ["retailer", { retailerId: "rakuten" }],
    ["source_url", { sourceUrl: "javascript:alert(1)" }],
    ["checked_at", { sourceCheckedAt: "now" }],
    ["period", { startDate: "2026-10-13", endDate: "2026-10-11" }],
  ])("returns to the form with error=%s and no insert", async (code, override) => {
    expect(await redirectUrl(createSaleCandidateAction(form({ ...VALID, ...override })))).toBe(
      `/admin/new?mode=date&error=${code}`,
    );
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });

  it("rejects a missing or inactive retailer found on the server", async () => {
    mocks.getActiveRetailerForAdmin.mockResolvedValue(null);

    expect(await redirectUrl(createSaleCandidateAction(form(VALID)))).toBe("/admin/new?mode=date&error=retailer");
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });

  it("rejects a source URL outside the retailer's official domain", async () => {
    expect(
      await redirectUrl(createSaleCandidateAction(form({ ...VALID, sourceUrl: "https://www.amazon.co.jp/" }))),
    ).toBe("/admin/new?mode=date&error=source_domain");
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });

  it("maps a database duplicate to the fixed duplicate message", async () => {
    mocks.createSaleCandidate.mockResolvedValue({ ok: false, reason: "duplicate" });

    expect(await redirectUrl(createSaleCandidateAction(form(VALID)))).toBe("/admin/new?mode=date&error=duplicate");
  });

  it("maps other failures to the generic failure", async () => {
    mocks.createSaleCandidate.mockResolvedValue({ ok: false, reason: "failed" });
    expect(await redirectUrl(createSaleCandidateAction(form(VALID)))).toBe("/admin/new?mode=date&error=failed");

    mocks.getActiveRetailerForAdmin.mockRejectedValue(new Error("network"));
    expect(await redirectUrl(createSaleCandidateAction(form(VALID)))).toBe("/admin/new?mode=date&error=failed");
  });

  it("keeps user input out of the redirect URL", async () => {
    const url = await redirectUrl(createSaleCandidateAction(form({ ...VALID, sourceUrl: "https://evil.example/secret" })));
    expect(url).not.toContain("evil");
    expect(url).not.toContain("Phase4D");
  });

  it("keeps a valid candidate id on error and drops anything else", async () => {
    const candidateId = "55555555-5555-4555-8555-555555555555";
    expect(await redirectUrl(createSaleCandidateAction(form({ ...VALID, title: " ", candidateId })))).toBe(
      `/admin/new?mode=date&candidateId=${candidateId}&error=title`,
    );
    expect(await redirectUrl(createSaleCandidateAction(form({ ...VALID, title: " ", candidateId: "x&error=y" })))).toBe(
      "/admin/new?mode=date&error=title",
    );
  });

  it("validates prefilled submissions like any other (no candidate shortcut)", async () => {
    const candidateId = "55555555-5555-4555-8555-555555555555";
    mocks.importRpc.mockResolvedValue({ data: null, error: { code: "23505", message: "duplicate key sale_events_active_dedup_uidx" } });

    expect(await redirectUrl(createSaleCandidateAction(form({ ...VALID, candidateId })))).toBe(
      `/admin/new?mode=date&candidateId=${candidateId}&error=duplicate`,
    );
    expect(mocks.getActiveRetailerForAdmin).toHaveBeenCalled();
    mocks.importRpc.mockClear();
    expect(await redirectUrl(createSaleCandidateAction(form({ ...VALID, candidateId, sourceUrl: "https://evil.example/" })))).toBe(
      `/admin/new?mode=date&candidateId=${candidateId}&error=source_domain`,
    );
  });
});

describe("createSaleCandidateAction source policy", () => {
  const amazon = (sourceUrl: string, extra: Record<string, string> = {}) => {
    mocks.getActiveRetailerForAdmin.mockResolvedValue(AMAZON);
    return redirectUrl(createSaleCandidateAction(form({ ...VALID, retailerId: AMAZON_ID, sourceUrl, ...extra })));
  };

  it("accepts Amazon's own domain without a policy lookup", async () => {
    expect(await amazon("https://www.amazon.co.jp/fmc/prime-day")).toBe(`/admin/sales/${NEW_ID}?done=created`);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("accepts an approved aboutamazon.jp article for Amazon", async () => {
    expect(await amazon(ABOUTAMAZON_ARTICLE)).toBe(`/admin/sales/${NEW_ID}?done=created`);
    expect(mocks.rpc).toHaveBeenCalledWith("is_allowed_manual_source", {
      p_retailer_id: AMAZON_ID,
      p_hostname: "www.aboutamazon.jp",
      p_source_url: ABOUTAMAZON_ARTICLE,
    });
    expect(mocks.createSaleCandidate.mock.calls[0][1]).toMatchObject({ sourceUrl: ABOUTAMAZON_ARTICLE });
  });

  it.each([
    ["lookalike domain", "https://evil-aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026"],
    ["evil suffix", "https://www.aboutamazon.jp.evil.example/news/amazon-prime/prime-appreciation-sale-2026"],
    ["other subdomain", "https://news.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026"],
    ["path outside the policy", "https://www.aboutamazon.jp/rss/feed.rss"],
  ])("rejects an Amazon %s", async (_label, sourceUrl) => {
    expect(await amazon(sourceUrl)).toBe("/admin/new?mode=date&error=source_domain");
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });

  it.each([
    ["Rakuten", RETAILER],
    ["Qoo10", QOO10],
  ])("rejects an aboutamazon.jp article for %s", async (_label, retailer) => {
    mocks.getActiveRetailerForAdmin.mockResolvedValue(retailer);
    expect(
      await redirectUrl(createSaleCandidateAction(form({ ...VALID, retailerId: retailer.id, sourceUrl: ABOUTAMAZON_ARTICLE }))),
    ).toBe("/admin/new?mode=date&error=source_domain");
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });

  it.each([
    ["http", "http://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026"],
    ["credentials", "https://user:pass@www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026"],
    ["port", "https://www.aboutamazon.jp:8443/news/amazon-prime/prime-appreciation-sale-2026"],
    ["default port", "https://www.aboutamazon.jp:443/news/amazon-prime/prime-appreciation-sale-2026"],
    ["port on the primary domain", "https://www.amazon.co.jp:8443/"],
  ])("rejects a URL with %s before any policy lookup", async (_label, sourceUrl) => {
    expect(await amazon(sourceUrl)).toBe("/admin/new?mode=date&error=source_url");
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });

  it("fails closed when the policy check errors", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "PGRST000" } });
    expect(await amazon(ABOUTAMAZON_ARTICLE)).toBe("/admin/new?mode=date&error=failed");
    mocks.rpc.mockRejectedValue(new Error("network"));
    expect(await amazon(ABOUTAMAZON_ARTICLE)).toBe("/admin/new?mode=date&error=failed");
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    expect(await amazon(ABOUTAMAZON_ARTICLE)).toBe("/admin/new?mode=date&error=source_domain");
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });

  it("checks the policy after the retailer and before the insert", async () => {
    const order: string[] = [];
    mocks.getActiveRetailerForAdmin.mockImplementation(async () => (order.push("retailer"), AMAZON));
    mocks.rpc.mockImplementation(async (...args: Parameters<typeof fakeRpc>) => (order.push("policy"), fakeRpc(...args)));
    mocks.createSaleCandidate.mockImplementation(async () => (order.push("insert"), { ok: true, id: NEW_ID }));

    await redirectUrl(createSaleCandidateAction(form({ ...VALID, retailerId: AMAZON_ID, sourceUrl: ABOUTAMAZON_ARTICLE })));

    expect(order).toEqual(["retailer", "policy", "insert"]);
  });

  it("validates a candidate-prefilled aboutamazon.jp URL on submit", async () => {
    const candidateId = "55555555-5555-4555-8555-555555555555";
    expect(await amazon(ABOUTAMAZON_ARTICLE, { candidateId })).toBe(`/admin/sales/${IMPORTED_ID}?done=created`);
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["is_allowed_manual_source", "import_collection_candidate"]);

    mocks.importRpc.mockClear();
    expect(await amazon("https://www.aboutamazon.jp.evil.example/news/a/b", { candidateId })).toBe(
      `/admin/new?mode=date&candidateId=${candidateId}&error=source_domain`,
    );
    expect(mocks.importRpc).not.toHaveBeenCalled();
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });
});

describe("createSaleCandidateAction candidate import", () => {
  const EDITED = {
    ...VALID,
    retailerId: AMAZON_ID,
    candidateId: CANDIDATE_ID,
    title: "  管理者が直したタイトル  ",
    description: "管理者が確認した説明",
    startDate: "2026-11-20",
    endDate: "2026-11-22",
    sourceUrl: ABOUTAMAZON_ARTICLE,
  };
  const submit = (fields: Record<string, string> = {}) => {
    mocks.getActiveRetailerForAdmin.mockResolvedValue(AMAZON);
    return redirectUrl(createSaleCandidateAction(form({ ...EDITED, ...fields })));
  };

  it("uses the existing manual create path without a candidate id", async () => {
    expect(await redirectUrl(createSaleCandidateAction(form(VALID)))).toBe(`/admin/sales/${NEW_ID}?done=created`);
    expect(mocks.createSaleCandidate).toHaveBeenCalledTimes(1);
    expect(mocks.importRpc).not.toHaveBeenCalled();
  });

  it("ignores a malformed candidate id and keeps the manual path", async () => {
    expect(await redirectUrl(createSaleCandidateAction(form({ ...VALID, candidateId: "not-a-uuid" })))).toBe(
      `/admin/sales/${NEW_ID}?done=created`,
    );
    expect(mocks.importRpc).not.toHaveBeenCalled();
  });

  it("imports through one atomic RPC with the admin's final values", async () => {
    expect(await submit()).toBe(`/admin/sales/${IMPORTED_ID}?done=created`);
    expect(mocks.importRpc).toHaveBeenCalledTimes(1);
    expect(mocks.importRpc).toHaveBeenCalledWith({
      p_candidate_id: CANDIDATE_ID,
      p_retailer_id: AMAZON_ID,
      p_title: "管理者が直したタイトル",
      p_description: "管理者が確認した説明",
      p_starts_at: "2026-11-19T15:00:00.000Z",
      p_ends_at: "2026-11-22T15:00:00.000Z",
      p_is_date_only: true,
      p_source_url: ABOUTAMAZON_ARTICLE,
      p_source_checked_at: "2026-10-11T00:30:00.000Z",
    });
    // No plain insert and no second write after the import.
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["is_allowed_manual_source", "import_collection_candidate"]);
  });

  it("imports with Amazon's primary domain (single RPC call, no policy lookup)", async () => {
    expect(await submit({ sourceUrl: "https://www.amazon.co.jp/fmc/prime-day", description: "" })).toBe(
      `/admin/sales/${IMPORTED_ID}?done=created`,
    );
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(["import_collection_candidate"]);
    expect(mocks.importRpc.mock.calls[0][0]).toMatchObject({ p_description: null });
  });

  it("never passes a status or internal field to the import", async () => {
    await submit({ status: "published", published_at: "x", title_key: "x", review_state: "imported" });
    expect(Object.keys(mocks.importRpc.mock.calls[0][0] as object).sort()).toEqual([
      "p_candidate_id",
      "p_description",
      "p_ends_at",
      "p_is_date_only",
      "p_retailer_id",
      "p_source_checked_at",
      "p_source_url",
      "p_starts_at",
      "p_title",
    ]);
  });

  it.each([
    ["55000", "candidate_state"],
    ["P0002", "candidate_state"],
    ["23505", "duplicate"],
    ["22023", "invalid_input"],
    ["42501", "failed"],
    ["XX000", "failed"],
  ])("maps database code %s to error=%s without details", async (code, reason) => {
    mocks.importRpc.mockResolvedValue({ data: null, error: { code, message: "candidate is not importable 候補A1" } });
    const url = await submit();
    expect(url).toBe(`/admin/new?mode=date&candidateId=${CANDIDATE_ID}&error=${reason}`);
    expect(url).not.toContain("importable");
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });

  it("fails closed on a thrown request or an unexpected result", async () => {
    mocks.importRpc.mockRejectedValue(new Error("network"));
    expect(await submit()).toBe(`/admin/new?mode=date&candidateId=${CANDIDATE_ID}&error=failed`);
    mocks.importRpc.mockResolvedValue({ data: "not-an-id", error: null });
    expect(await submit()).toBe(`/admin/new?mode=date&candidateId=${CANDIDATE_ID}&error=failed`);
    expect(mocks.createSaleCandidate).not.toHaveBeenCalled();
  });

  it.each([
    ["source domain", { sourceUrl: "https://evil-aboutamazon.jp/news/a/b" }, "source_domain"],
    ["form validation", { title: " " }, "title"],
  ])("does not call the import after a %s failure", async (_label, fields, code) => {
    expect(await submit(fields)).toBe(`/admin/new?mode=date&candidateId=${CANDIDATE_ID}&error=${code}`);
    expect(mocks.importRpc).not.toHaveBeenCalled();
  });
});

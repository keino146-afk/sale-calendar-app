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

const CLIENT = { fake: "admin client" };
const RETAILER_ID = "11111111-1111-4111-8111-111111111111";
const NEW_ID = "44444444-4444-4444-8444-444444444444";
const RETAILER = { id: RETAILER_ID, slug: "rakuten", name: "楽天市場", officialBaseUrl: "https://www.rakuten.co.jp/" };

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
});

afterEach(() => {
  for (const mock of [
    mocks.isSameOriginRequest,
    mocks.requireAdmin,
    mocks.getActiveRetailerForAdmin,
    mocks.createSaleCandidate,
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
});

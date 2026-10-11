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
    publishSaleEvent: vi.fn(),
    rejectSaleEvent: vi.fn(),
    archiveSaleEvent: vi.fn(),
    reopenSaleEvent: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new RedirectSentinel(url);
    }),
    REDIRECT: RedirectSentinel,
  };
});

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth/admin-auth", () => ({ isSameOriginRequest: mocks.isSameOriginRequest }));
vi.mock("@/server/auth/admin-session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/server/data/admin-sale-actions", () => ({
  publishSaleEvent: mocks.publishSaleEvent,
  rejectSaleEvent: mocks.rejectSaleEvent,
  archiveSaleEvent: mocks.archiveSaleEvent,
  reopenSaleEvent: mocks.reopenSaleEvent,
}));

const { publishSaleAction, rejectSaleAction, archiveSaleAction, reopenSaleAction } = await import("./actions");

const ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT = { fake: "admin client" };
const RPCS = [mocks.publishSaleEvent, mocks.rejectSaleEvent, mocks.archiveSaleEvent, mocks.reopenSaleEvent];

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

const SIMPLE_ACTIONS = [
  ["publish", publishSaleAction, mocks.publishSaleEvent, "published"],
  ["archive", archiveSaleAction, mocks.archiveSaleEvent, "archived"],
  ["reopen", reopenSaleAction, mocks.reopenSaleEvent, "reopened"],
] as const;

const ALL_ACTIONS = [
  ...SIMPLE_ACTIONS.map(([name, action]) => [name, action, {}] as const),
  ["reject", rejectSaleAction, { reason: "理由" }] as const,
];

beforeEach(() => {
  mocks.isSameOriginRequest.mockResolvedValue(true);
  mocks.requireAdmin.mockResolvedValue(CLIENT);
  for (const rpc of RPCS) rpc.mockResolvedValue({ ok: true });
});

afterEach(() => {
  for (const mock of [mocks.isSameOriginRequest, mocks.requireAdmin, ...RPCS]) mock.mockReset();
  mocks.redirect.mockClear();
});

describe.each(ALL_ACTIONS)("%s action guards", (_name, action, extra) => {
  it("rejects a missing or foreign Origin before checking the session", async () => {
    mocks.isSameOriginRequest.mockResolvedValue(false);

    expect(await redirectUrl(action(form({ saleId: ID, ...extra })))).toBe("/admin");
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    for (const rpc of RPCS) expect(rpc).not.toHaveBeenCalled();
  });

  it("never reaches the RPC for an unauthenticated visitor", async () => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login"));

    expect(await redirectUrl(action(form({ saleId: ID, ...extra })))).toBe("/admin/login");
    for (const rpc of RPCS) expect(rpc).not.toHaveBeenCalled();
  });

  it("never reaches the RPC for a signed-in non-admin", async () => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login?error=1"));

    expect(await redirectUrl(action(form({ saleId: ID, ...extra })))).toBe("/admin/login?error=1");
    for (const rpc of RPCS) expect(rpc).not.toHaveBeenCalled();
  });

  it.each(["", "not-a-uuid", `${ID}x`, "../../etc"])("does not call the RPC for sale id %j", async (saleId) => {
    expect(await redirectUrl(action(form({ saleId, ...extra })))).toBe("/admin");
    for (const rpc of RPCS) expect(rpc).not.toHaveBeenCalled();
  });

  it("checks Origin, then the admin session, then calls the RPC", async () => {
    const order: string[] = [];
    mocks.isSameOriginRequest.mockImplementation(async () => (order.push("origin"), true));
    mocks.requireAdmin.mockImplementation(async () => (order.push("admin"), CLIENT));
    for (const rpc of RPCS) rpc.mockImplementation(async () => (order.push("rpc"), { ok: true }));

    await redirectUrl(action(form({ saleId: ID, ...extra })));

    expect(order).toEqual(["origin", "admin", "rpc"]);
  });
});

describe.each(SIMPLE_ACTIONS)("%s action", (_name, action, rpc, done) => {
  it("calls only its RPC with the admin client and shows the success message", async () => {
    expect(await redirectUrl(action(form({ saleId: ID })))).toBe(`/admin/sales/${ID}?done=${done}`);
    expect(rpc).toHaveBeenCalledWith(CLIENT, ID);
    for (const other of RPCS.filter((candidate) => candidate !== rpc)) expect(other).not.toHaveBeenCalled();
  });

  it("shows the generic failure when the RPC refuses (e.g. wrong state)", async () => {
    rpc.mockResolvedValue({ ok: false });

    expect(await redirectUrl(action(form({ saleId: ID })))).toBe(`/admin/sales/${ID}?error=1`);
  });
});

describe("reject action", () => {
  it("normalizes the reason and calls reject_sale_event", async () => {
    expect(await redirectUrl(rejectSaleAction(form({ saleId: ID, reason: "　期間が誤り\n" })))).toBe(
      `/admin/sales/${ID}?done=rejected`,
    );
    expect(mocks.rejectSaleEvent).toHaveBeenCalledWith(CLIENT, ID, "期間が誤り");
  });

  it.each([
    ["missing", {}],
    ["empty", { reason: "" }],
    ["whitespace only", { reason: " 　\t\n" }],
    ["too long", { reason: "あ".repeat(2001) }],
  ])("sends a %s reason back to the confirmation page without calling the RPC", async (_label, extra) => {
    expect(await redirectUrl(rejectSaleAction(form({ saleId: ID, ...extra })))).toBe(
      `/admin/sales/${ID}/reject?error=reason`,
    );
    expect(mocks.rejectSaleEvent).not.toHaveBeenCalled();
  });

  it("accepts a 2000-character reason", async () => {
    await redirectUrl(rejectSaleAction(form({ saleId: ID, reason: "あ".repeat(2000) })));
    expect(mocks.rejectSaleEvent).toHaveBeenCalledTimes(1);
  });

  it("shows the generic failure when the RPC refuses", async () => {
    mocks.rejectSaleEvent.mockResolvedValue({ ok: false });

    expect(await redirectUrl(rejectSaleAction(form({ saleId: ID, reason: "理由" })))).toBe(
      `/admin/sales/${ID}?error=1`,
    );
  });
});

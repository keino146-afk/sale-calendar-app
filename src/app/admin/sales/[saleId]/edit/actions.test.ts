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
    getAdminSaleEventForEdit: vi.fn(),
    updateSaleEvent: vi.fn(),
    checkSaleSourceUrl: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new RedirectSentinel(url);
    }),
    REDIRECT: RedirectSentinel,
  };
});

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth/admin-auth", () => ({ isSameOriginRequest: mocks.isSameOriginRequest }));
vi.mock("@/server/auth/admin-session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/server/data/admin-sale-edit", () => ({
  getAdminSaleEventForEdit: mocks.getAdminSaleEventForEdit,
  updateSaleEvent: mocks.updateSaleEvent,
}));
vi.mock("@/server/data/admin-source-policy", () => ({ checkSaleSourceUrl: mocks.checkSaleSourceUrl }));

const { updateSaleAction } = await import("./actions");

const ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RETAILER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT = { fake: "admin client" };
const UPDATED_AT = "2026-10-14T03:04:05.123456+00:00";

const SALE = {
  id: ID,
  status: "pending_review",
  title: "プライム感謝祭 先行セール",
  description: null,
  startsAt: "2026-10-12T15:00:00+00:00",
  endsAt: "2026-10-15T14:59:00+00:00",
  isDateOnly: false,
  sourceUrl: "https://www.amazon.co.jp/fmc/prime",
  sourceCheckedAt: "2026-10-12T01:00:00+00:00",
  updatedAt: UPDATED_AT,
  retailer: { id: RETAILER_ID, slug: "amazon", name: "Amazon", officialBaseUrl: "https://www.amazon.co.jp/" },
};

// The fix from Phase 6C: end 10/16 00:00 JST instead of 10/15 23:59.
const VALID = {
  saleId: ID,
  mode: "datetime",
  expectedUpdatedAt: UPDATED_AT,
  title: "プライム感謝祭 先行セール",
  description: "",
  startsAt: "2026-10-13T00:00",
  endsAt: "2026-10-16T00:00",
  sourceUrl: "https://www.amazon.co.jp/fmc/prime",
  sourceCheckedAt: "2026-10-12T10:00",
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

const submit = (fields: Record<string, string> = {}) => redirectUrl(updateSaleAction(form({ ...VALID, ...fields })));
const back = (error: string, mode = "datetime") => `/admin/sales/${ID}/edit?mode=${mode}&error=${error}`;

beforeEach(() => {
  mocks.isSameOriginRequest.mockResolvedValue(true);
  mocks.requireAdmin.mockResolvedValue(CLIENT);
  mocks.getAdminSaleEventForEdit.mockResolvedValue(SALE);
  mocks.checkSaleSourceUrl.mockResolvedValue("allowed");
  mocks.updateSaleEvent.mockResolvedValue({ ok: true });
});

afterEach(() => {
  for (const mock of [
    mocks.isSameOriginRequest,
    mocks.requireAdmin,
    mocks.getAdminSaleEventForEdit,
    mocks.updateSaleEvent,
    mocks.checkSaleSourceUrl,
  ]) {
    mock.mockReset();
  }
  mocks.redirect.mockClear();
});

describe("updateSaleAction guards", () => {
  it("rejects a missing or foreign Origin before checking the session", async () => {
    mocks.isSameOriginRequest.mockResolvedValue(false);

    expect(await submit()).toBe("/admin");
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.updateSaleEvent).not.toHaveBeenCalled();
  });

  it("propagates the admin guard's redirect for visitors who are not admins", async () => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login"));

    expect(await submit()).toBe("/admin/login");
    expect(mocks.getAdminSaleEventForEdit).not.toHaveBeenCalled();
    expect(mocks.updateSaleEvent).not.toHaveBeenCalled();
  });

  it("rejects a malformed sale id without reading", async () => {
    expect(await submit({ saleId: "x&error=y" })).toBe("/admin");
    expect(mocks.getAdminSaleEventForEdit).not.toHaveBeenCalled();
  });
});

describe("updateSaleAction", () => {
  it("saves through the RPC and returns to the detail page", async () => {
    expect(await submit()).toBe(`/admin/sales/${ID}?done=updated`);
    expect(mocks.getAdminSaleEventForEdit).toHaveBeenCalledWith(CLIENT, ID);
    expect(mocks.checkSaleSourceUrl).toHaveBeenCalledWith(
      CLIENT,
      { id: RETAILER_ID, officialBaseUrl: "https://www.amazon.co.jp/" },
      "https://www.amazon.co.jp/fmc/prime",
    );
    expect(mocks.updateSaleEvent).toHaveBeenCalledWith(CLIENT, {
      id: ID,
      expectedUpdatedAt: UPDATED_AT,
      publishedConfirmed: false,
      content: {
        title: "プライム感謝祭 先行セール",
        description: null,
        startsAt: new Date("2026-10-12T15:00:00.000Z"),
        endsAt: new Date("2026-10-15T15:00:00.000Z"),
        isDateOnly: false,
        sourceUrl: "https://www.amazon.co.jp/fmc/prime",
        sourceCheckedAt: new Date("2026-10-12T01:00:00.000Z"),
      },
    });
  });

  it("never takes the retailer or the status from the form", async () => {
    await submit({ retailerId: "22222222-2222-4222-8222-222222222222", status: "published" });

    const call = mocks.updateSaleEvent.mock.calls[0][1];
    expect(call).not.toHaveProperty("retailerId");
    expect(call).not.toHaveProperty("status");
    expect(call.content).not.toHaveProperty("retailerId");
    // The source check uses the sale's own retailer.
    expect(mocks.checkSaleSourceUrl.mock.calls[0][1]).toEqual({ id: RETAILER_ID, officialBaseUrl: "https://www.amazon.co.jp/" });
  });

  it("saves a date-only period with the inclusive last day", async () => {
    await submit({ mode: "date", startDate: "2026-10-13", endDate: "2026-10-15" });

    expect(mocks.updateSaleEvent.mock.calls[0][1].content).toMatchObject({
      startsAt: new Date("2026-10-12T15:00:00.000Z"),
      endsAt: new Date("2026-10-15T15:00:00.000Z"),
      isDateOnly: true,
    });
  });

  it.each([
    ["pending_review", "published"],
    ["rejected", "rejected"],
  ])("edits a %s sale without any confirmation", async (status) => {
    mocks.getAdminSaleEventForEdit.mockResolvedValue({ ...SALE, status });

    expect(await submit()).toBe(`/admin/sales/${ID}?done=updated`);
    expect(mocks.updateSaleEvent.mock.calls[0][1].publishedConfirmed).toBe(false);
  });

  it("requires the published confirmation on the server", async () => {
    mocks.getAdminSaleEventForEdit.mockResolvedValue({ ...SALE, status: "published" });

    expect(await submit()).toBe(back("confirm_published"));
    expect(await submit({ confirmPublished: "yes" })).toBe(back("confirm_published"));
    expect(mocks.updateSaleEvent).not.toHaveBeenCalled();

    expect(await submit({ confirmPublished: "on" })).toBe(`/admin/sales/${ID}?done=updated`);
    expect(mocks.updateSaleEvent.mock.calls[0][1].publishedConfirmed).toBe(true);
  });

  it("refuses a form loaded before the sale changed (e.g. published in another tab)", async () => {
    mocks.getAdminSaleEventForEdit.mockResolvedValue({
      ...SALE,
      status: "published",
      updatedAt: "2026-10-14T03:05:00.000001+00:00",
    });

    expect(await submit()).toBe(back("stale"));
    expect(await submit({ expectedUpdatedAt: "" })).toBe(back("stale"));
    expect(mocks.updateSaleEvent).not.toHaveBeenCalled();
  });

  it("refuses an archived sale", async () => {
    mocks.getAdminSaleEventForEdit.mockResolvedValue({ ...SALE, status: "archived" });

    expect(await submit({ confirmPublished: "on" })).toBe(back("not_editable"));
    expect(mocks.updateSaleEvent).not.toHaveBeenCalled();
  });

  it("handles a missing sale and a failed read", async () => {
    mocks.getAdminSaleEventForEdit.mockResolvedValue(null);
    expect(await submit()).toBe(back("not_found"));
    mocks.getAdminSaleEventForEdit.mockRejectedValue(new Error("db"));
    expect(await submit()).toBe(back("failed"));
    expect(mocks.updateSaleEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["title", { title: " " }],
    ["period", { endsAt: "2026-10-13T00:00" }],
    ["source_url", { sourceUrl: "http://www.amazon.co.jp/fmc/prime" }],
    ["source_url", { sourceUrl: "https://user:pass@www.amazon.co.jp/fmc/prime" }],
    ["source_url", { sourceUrl: "https://www.amazon.co.jp:443/fmc/prime" }],
    ["checked_at", { sourceCheckedAt: "" }],
  ])("rejects invalid input with the %s error", async (error, fields) => {
    expect(await submit(fields)).toBe(back(error));
    expect(mocks.updateSaleEvent).not.toHaveBeenCalled();
  });

  it("requires a newer checked time when the source URL changes", async () => {
    const newUrl = "https://www.amazon.co.jp/fmc/prime-day";
    expect(await submit({ sourceUrl: newUrl })).toBe(back("checked_at_not_newer"));
    expect(await submit({ sourceUrl: newUrl, sourceCheckedAt: "2026-10-12T09:59" })).toBe(back("checked_at_not_newer"));
    expect(mocks.updateSaleEvent).not.toHaveBeenCalled();

    expect(await submit({ sourceUrl: newUrl, sourceCheckedAt: "2026-10-12T10:01" })).toBe(`/admin/sales/${ID}?done=updated`);
  });

  it("rejects a source outside the sale's retailer and fails closed", async () => {
    mocks.checkSaleSourceUrl.mockResolvedValue("rejected");
    expect(await submit()).toBe(back("source_domain"));
    mocks.checkSaleSourceUrl.mockResolvedValue("failed");
    expect(await submit()).toBe(back("failed"));
    expect(mocks.updateSaleEvent).not.toHaveBeenCalled();
  });

  it.each(["duplicate", "stale", "not_editable", "not_found", "invalid_input", "failed"])(
    "shows the fixed %s message when the RPC refuses",
    async (reason) => {
      mocks.updateSaleEvent.mockResolvedValue({ ok: false, reason });
      expect(await submit()).toBe(back(reason));
    },
  );

  it("keeps user input out of the redirect URL", async () => {
    const url = await submit({ title: " ", description: "secret-text" });
    expect(url).not.toContain("secret");
    expect(url).not.toContain("プライム");
  });
});

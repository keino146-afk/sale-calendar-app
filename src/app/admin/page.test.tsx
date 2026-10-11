import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RedirectSentinel extends Error {
    constructor(public readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return {
    connection: vi.fn(),
    requireAdmin: vi.fn(),
    listAdminSaleEvents: vi.fn(),
    countPendingSaleEvents: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new RedirectSentinel(url);
    }),
    REDIRECT: RedirectSentinel,
  };
});

vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth/admin-session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/server/data/admin-sale-events", () => ({
  listAdminSaleEvents: mocks.listAdminSaleEvents,
  countPendingSaleEvents: mocks.countPendingSaleEvents,
}));
vi.mock("./actions", () => ({ logoutAction: vi.fn() }));

const { default: AdminPage } = await import("./page");

// Fake values only. The identity fields must never reach the HTML.
const FAKE_CLIENT = {
  user: {
    id: "00000000-0000-4000-8000-0000000000aa",
    email: "admin@example.invalid",
    access_token: "eyJFAKE.ACCESS.TOKEN",
  },
};

function sale(id: string, title: string, status: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title,
    description: null,
    startsAt: "2026-10-31T15:00:00Z",
    endsAt: "2026-11-03T15:00:00Z",
    isDateOnly: true,
    status,
    sourceUrl: "https://www.rakuten.co.jp/event/",
    sourceCheckedAt: null,
    publishedAt: null,
    rejectedAt: null,
    archivedAt: null,
    retailer: { slug: "rakuten", name: "楽天市場" },
    ...overrides,
  };
}

const PENDING_A = sale("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "新しい候補", "pending_review", {
  sourceCheckedAt: "2026-10-31T15:30:00Z",
});
const PENDING_B = sale("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "古い候補", "pending_review");

function props(params: Record<string, string | string[] | undefined> = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(params) };
}

async function render(params: Record<string, string | string[] | undefined> = {}) {
  return renderToStaticMarkup(await AdminPage(props(params)));
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
  mocks.connection.mockResolvedValue(undefined);
  mocks.requireAdmin.mockResolvedValue(FAKE_CLIENT);
  mocks.listAdminSaleEvents.mockResolvedValue([]);
  mocks.countPendingSaleEvents.mockResolvedValue(0);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [mocks.connection, mocks.requireAdmin, mocks.listAdminSaleEvents, mocks.countPendingSaleEvents]) {
    mock.mockReset();
  }
  mocks.redirect.mockClear();
});

describe("AdminPage", () => {
  it("requires an admin before reading any data, then reads twice with the admin client", async () => {
    const order: string[] = [];
    mocks.connection.mockImplementation(async () => void order.push("connection"));
    mocks.requireAdmin.mockImplementation(async () => {
      order.push("requireAdmin");
      return FAKE_CLIENT;
    });
    mocks.listAdminSaleEvents.mockImplementation(async () => {
      order.push("list");
      return [];
    });
    mocks.countPendingSaleEvents.mockImplementation(async () => {
      order.push("count");
      return 0;
    });

    await render();

    expect(order.slice(0, 2)).toEqual(["connection", "requireAdmin"]);
    expect(order.slice(2).sort()).toEqual(["count", "list"]);
    expect(mocks.listAdminSaleEvents).toHaveBeenCalledTimes(1);
    expect(mocks.countPendingSaleEvents).toHaveBeenCalledTimes(1);
    expect(mocks.listAdminSaleEvents.mock.calls[0][0]).toBe(FAKE_CLIENT);
    expect(mocks.countPendingSaleEvents.mock.calls[0][0]).toBe(FAKE_CLIENT);
  });

  it("reads nothing for visitors who are not admins", async () => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login"));

    expect(await redirectUrl(AdminPage(props()))).toBe("/admin/login");
    expect(mocks.listAdminSaleEvents).not.toHaveBeenCalled();
    expect(mocks.countPendingSaleEvents).not.toHaveBeenCalled();
  });

  it("propagates the non-admin rejection from the guard", async () => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login?error=1"));

    expect(await redirectUrl(AdminPage(props()))).toBe("/admin/login?error=1");
    expect(mocks.listAdminSaleEvents).not.toHaveBeenCalled();
  });

  it("does not swallow connection() failures", async () => {
    const interrupt = new Error("prerender interrupted");
    mocks.connection.mockRejectedValue(interrupt);

    await expect(AdminPage(props())).rejects.toBe(interrupt);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });

  it("defaults to pending_review", async () => {
    await render();
    expect(mocks.listAdminSaleEvents).toHaveBeenCalledWith(FAKE_CLIENT, { status: "pending_review" });
  });

  it.each(["published", "rejected", "archived"])("filters by %s", async (status) => {
    const html = await render({ status });

    expect(mocks.listAdminSaleEvents).toHaveBeenCalledWith(FAKE_CLIENT, { status });
    expect(html).toMatch(new RegExp(`<a aria-current="page"[^>]*href="/admin\\?status=${status}"`));
  });

  it.each([
    ["invalid", { status: "deleted" }],
    ["repeated", { status: ["published", "published"] }],
  ])("falls back to pending_review for a %s status", async (_label, params) => {
    await render(params);
    expect(mocks.listAdminSaleEvents).toHaveBeenCalledWith(FAKE_CLIENT, { status: "pending_review" });
  });

  it("shows the header, pending count and four status tabs", async () => {
    mocks.countPendingSaleEvents.mockResolvedValue(3);

    const html = await render({ status: "published" });

    expect(html).toContain("管理画面");
    expect(html).toContain("ログアウト</button>");
    expect(html).toContain('data-pending-count="3"');
    expect(html).toContain("3件");
    for (const [status, label] of [
      ["pending_review", "確認待ち"],
      ["published", "公開中"],
      ["rejected", "却下"],
      ["archived", "終了"],
    ]) {
      expect(html).toContain(`href="/admin?status=${status}"`);
      expect(html).toContain(`>${label}</a>`);
    }
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
  });

  it("links to the new sale form", async () => {
    const html = await render();

    expect(html).toContain('href="/admin/new"');
    expect(html).toContain("新しいセールを登録");
  });

  it("lists sales in DAL order with status, period, checked date and detail links", async () => {
    mocks.listAdminSaleEvents.mockResolvedValue([PENDING_A, PENDING_B]);

    const html = await render();

    expect(html.indexOf("新しい候補")).toBeLessThan(html.indexOf("古い候補"));
    expect(html).toContain(`href="/admin/sales/${PENDING_A.id}"`);
    expect(html).toContain(`href="/admin/sales/${PENDING_B.id}"`);
    expect(html).toContain('data-status="pending_review"');
    expect(html).toContain("楽天市場");
    expect(html).toContain("11/1(日) 〜 11/3(火)");
    expect(html).toContain("2026/11/1 時点の情報");
    expect(html.match(/時点の情報/g)).toHaveLength(1);
  });

  it.each([
    ["pending_review", "確認待ちのセールはありません"],
    ["published", "公開中のセールはありません"],
    ["rejected", "却下したセールはありません"],
    ["archived", "終了したセールはありません"],
  ])("shows the empty state for %s", async (status, text) => {
    const html = await render({ status });
    expect(html).toContain(text);
    expect(html).not.toContain('href="/admin/sales/');
  });

  it("shows a generic error without raw details when a read fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.countPendingSaleEvents.mockRejectedValue(
      Object.assign(new Error("permission denied for sale_events secret_detail"), { name: "DataAccessError" }),
    );

    const html = await render();

    expect(html).toContain("セール情報を読み込めませんでした");
    expect(html).not.toContain("secret_detail");
    expect(html).not.toContain("確認待ち</span>");
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("DataAccessError");
    expect(logged).not.toContain("secret_detail");
  });

  it("never renders identity details or mutation controls", async () => {
    mocks.listAdminSaleEvents.mockResolvedValue([PENDING_A]);

    const html = await render();

    expect(html).not.toContain(FAKE_CLIENT.user.id);
    expect(html).not.toContain(FAKE_CLIENT.user.email);
    expect(html).not.toMatch(/eyJ|access_token|refresh_token/);
    for (const label of ["公開する", "却下する", "終了する", "再開", "編集"]) {
      expect(html).not.toContain(label);
    }
    // The only form is logout.
    expect(html.match(/<form/g)).toHaveLength(1);
  });
});

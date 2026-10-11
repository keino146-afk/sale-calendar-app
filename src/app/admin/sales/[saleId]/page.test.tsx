import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RedirectSentinel extends Error {
    constructor(public readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  const NOT_FOUND = new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  return {
    connection: vi.fn(),
    requireAdmin: vi.fn(),
    getAdminSaleEvent: vi.fn(),
    notFound: vi.fn(() => {
      throw NOT_FOUND;
    }),
    redirect: vi.fn((url: string) => {
      throw new RedirectSentinel(url);
    }),
    NOT_FOUND,
    REDIRECT: RedirectSentinel,
  };
});

vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/server/auth/admin-session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/server/data/admin-sale-events", () => ({ getAdminSaleEvent: mocks.getAdminSaleEvent }));

const { default: AdminSaleDetailPage } = await import("./page");

const SALE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FAKE_CLIENT = { user: { id: "00000000-0000-4000-8000-0000000000aa", email: "admin@example.invalid" } };

const SALE = {
  id: SALE_ID,
  title: "候補セール",
  description: "最大50%OFF",
  startsAt: "2026-11-04T11:00:00Z",
  endsAt: "2026-11-10T17:00:00Z",
  isDateOnly: false,
  status: "published",
  sourceUrl: "https://www.rakuten.co.jp/event/supersale/",
  sourceCheckedAt: "2026-10-31T15:30:00Z",
  publishedAt: "2026-11-01T01:00:00Z",
  rejectedAt: null,
  archivedAt: null,
  retailer: { slug: "rakuten", name: "楽天市場" },
};

function props(saleId = SALE_ID) {
  return { params: Promise.resolve({ saleId }), searchParams: Promise.resolve({}) };
}

async function render(saleId = SALE_ID) {
  return renderToStaticMarkup(await AdminSaleDetailPage(props(saleId)));
}

beforeEach(() => {
  mocks.connection.mockResolvedValue(undefined);
  mocks.requireAdmin.mockResolvedValue(FAKE_CLIENT);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [mocks.connection, mocks.requireAdmin, mocks.getAdminSaleEvent]) mock.mockReset();
  mocks.notFound.mockClear();
  mocks.redirect.mockClear();
});

describe("AdminSaleDetailPage", () => {
  it("requires an admin, then reads one sale with the admin client", async () => {
    const order: string[] = [];
    mocks.connection.mockImplementation(async () => void order.push("connection"));
    mocks.requireAdmin.mockImplementation(async () => {
      order.push("requireAdmin");
      return FAKE_CLIENT;
    });
    mocks.getAdminSaleEvent.mockImplementation(async (_client: unknown, id: string) => {
      order.push(`get:${id}`);
      return SALE;
    });

    await render();

    expect(order).toEqual(["connection", "requireAdmin", `get:${SALE_ID}`]);
    expect(mocks.getAdminSaleEvent).toHaveBeenCalledTimes(1);
    expect(mocks.getAdminSaleEvent.mock.calls[0][0]).toBe(FAKE_CLIENT);
  });

  it("rejects visitors who are not admins before reading", async () => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login"));

    await expect(AdminSaleDetailPage(props())).rejects.toBeInstanceOf(mocks.REDIRECT);
    expect(mocks.getAdminSaleEvent).not.toHaveBeenCalled();
  });

  it("renders the review fields", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue(SALE);

    const html = await render();

    expect(html).toContain("候補セール");
    expect(html).toContain("楽天市場");
    expect(html).toContain('data-status="published"');
    expect(html).toContain("公開中");
    expect(html).toContain("11/4 20:00 〜 11/11 02:00");
    expect(html).toContain("時刻あり");
    expect(html).toContain("2026/11/4 20:00");
    expect(html).toContain("2026/11/11 02:00");
    expect(html).toContain("2026/11/1 00:30");
    expect(html).toContain("公開日時");
    expect(html).toContain("2026/11/1 10:00");
    expect(html).not.toContain("却下日時");
    expect(html).not.toContain("終了日時");
    expect(html).toContain("最大50%OFF");
    expect(html).toContain('href="/admin"');
  });

  it("links to the official source safely", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue(SALE);

    const html = await render();

    expect(html).toContain(`href="${SALE.sourceUrl}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain("公式ページを見る");
  });

  it("shows rejected and archived state timestamps", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue({
      ...SALE,
      status: "rejected",
      publishedAt: null,
      rejectedAt: "2026-11-02T03:00:00Z",
      isDateOnly: true,
    });
    const rejected = await render();
    expect(rejected).toContain("却下日時");
    expect(rejected).toContain("2026/11/2 12:00");
    expect(rejected).toContain("日付のみ");

    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, status: "archived", archivedAt: "2026-11-20T00:00:00Z" });
    const archived = await render();
    expect(archived).toContain("終了日時");
    expect(archived).toContain("2026/11/20 09:00");
  });

  it("omits the description when null and marks a missing checked date", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, description: null, sourceCheckedAt: null });

    const html = await render();

    expect(html).not.toContain("最大50%OFF");
    expect(html).not.toContain(">説明<");
    expect(html).toContain("未設定");
  });

  it.each(["not-a-uuid", "missing"])("returns 404 when the DAL finds nothing (%s)", async (id) => {
    mocks.getAdminSaleEvent.mockResolvedValue(null);

    await expect(AdminSaleDetailPage(props(id))).rejects.toBe(mocks.NOT_FOUND);
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
  });

  it("shows a generic error (not 404) when loading fails", async () => {
    mocks.getAdminSaleEvent.mockRejectedValue(new Error("secret_detail from upstream"));

    const html = await render();

    expect(html).toContain("セール情報を読み込めませんでした");
    expect(html).not.toContain("secret_detail");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  it("never renders internal fields, identity or mutation controls", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, title_key: "internal-key", start_date_jst: "2026-11-05" });

    const html = await render();

    for (const hidden of ["internal-key", "title_key", "start_date_jst", FAKE_CLIENT.user.id, FAKE_CLIENT.user.email]) {
      expect(html).not.toContain(hidden);
    }
    expect(html).not.toMatch(/eyJ|access_token|refresh_token/);
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });
});

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
    getLatestRejectReason: vi.fn(),
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
vi.mock("@/server/data/admin-sale-events", () => ({
  getAdminSaleEvent: mocks.getAdminSaleEvent,
  getLatestRejectReason: mocks.getLatestRejectReason,
}));
vi.mock("./actions", () => ({
  publishSaleAction: vi.fn(),
  archiveSaleAction: vi.fn(),
  reopenSaleAction: vi.fn(),
}));

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

type Query = Record<string, string | string[] | undefined>;

function props(saleId = SALE_ID, query: Query = {}) {
  return { params: Promise.resolve({ saleId }), searchParams: Promise.resolve(query) };
}

async function render(saleId = SALE_ID, query: Query = {}) {
  return renderToStaticMarkup(await AdminSaleDetailPage(props(saleId, query)));
}

function actionLabels(html: string): string[] {
  const section = html.slice(html.indexOf('aria-label="操作"'));
  if (!html.includes('aria-label="操作"')) return [];
  return [...section.matchAll(/>(公開する|却下する|終了する|確認待ちに戻す)</g)].map(([, label]) => label);
}

beforeEach(() => {
  mocks.connection.mockResolvedValue(undefined);
  mocks.requireAdmin.mockResolvedValue(FAKE_CLIENT);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [mocks.connection, mocks.requireAdmin, mocks.getAdminSaleEvent, mocks.getLatestRejectReason]) {
    mock.mockReset();
  }
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

  it("never renders internal fields, identity, edit or create controls", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, title_key: "internal-key", start_date_jst: "2026-11-05" });

    const html = await render();

    for (const hidden of ["internal-key", "title_key", "start_date_jst", FAKE_CLIENT.user.id, FAKE_CLIENT.user.email]) {
      expect(html).not.toContain(hidden);
    }
    expect(html).not.toMatch(/eyJ|access_token|refresh_token/);
    for (const label of ["編集", "新規", "作成"]) expect(html).not.toContain(label);
  });

  it.each([
    ["pending_review", ["公開する", "却下する"]],
    ["published", ["終了する"]],
    ["rejected", ["確認待ちに戻す"]],
    ["archived", []],
  ])("offers only the allowed actions for %s", async (status, labels) => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, status });
    mocks.getLatestRejectReason.mockResolvedValue("理由");

    const html = await render();

    expect(actionLabels(html)).toEqual(labels);
    // Each button form posts the sale id as a hidden field.
    expect(html.match(/<form/g)?.length ?? 0).toBe(labels.filter((label) => label !== "却下する").length);
    if (labels.length > 0 && labels[0] !== "却下する") {
      expect(html).toContain(`name="saleId" value="${SALE_ID}"`);
    }
  });

  it("links reject to the confirmation page instead of posting directly", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, status: "pending_review" });

    const html = await render();

    expect(html).toContain(`href="/admin/sales/${SALE_ID}/reject"`);
  });

  it("shows the latest reject reason only for rejected sales", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, status: "rejected", rejectedAt: "2026-11-02T03:00:00Z" });
    mocks.getLatestRejectReason.mockResolvedValue("期間が公式と違う");

    const rejected = await render();

    expect(mocks.getLatestRejectReason).toHaveBeenCalledWith(FAKE_CLIENT, SALE_ID);
    expect(rejected).toContain("却下理由");
    expect(rejected).toContain("期間が公式と違う");

    mocks.getLatestRejectReason.mockClear();
    for (const status of ["pending_review", "published", "archived"]) {
      mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, status });
      const html = await render();
      expect(html).not.toContain("却下理由");
      expect(html).not.toContain("期間が公式と違う");
    }
    // A reopened (pending) sale does not even read the audit log.
    expect(mocks.getLatestRejectReason).not.toHaveBeenCalled();
  });

  it("handles a rejected sale without a recorded reason", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, status: "rejected" });
    mocks.getLatestRejectReason.mockResolvedValue(null);

    expect(await render()).toContain("記録がありません");
  });

  it.each([
    ["published", "公開しました"],
    ["rejected", "却下しました"],
    ["archived", "終了しました"],
    ["reopened", "確認待ちに戻しました"],
  ])("shows the fixed success message for done=%s", async (done, message) => {
    mocks.getAdminSaleEvent.mockResolvedValue(SALE);
    mocks.getLatestRejectReason.mockResolvedValue(null);

    const html = await render(SALE_ID, { done });

    expect(html).toContain(message);
    expect(html).toContain('role="status"');
  });

  it("never echoes unknown query values", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue(SALE);

    const html = await render(SALE_ID, { done: "<script>x</script>", error: "P0002 secret_detail" });

    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("secret_detail");
    expect(html).not.toContain('role="status"');
    expect(html).toContain("操作を完了できませんでした");
  });
});

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
// Each mocked Server Action renders as a distinct form URL (React's
// $$FORM_ACTION hook; name: null adds no hidden field), so a test can tell
// which action a form is wired to.
vi.mock("./actions", () => {
  const formAction = (name: string) =>
    Object.assign(vi.fn(), { $$FORM_ACTION: () => ({ action: `/__action/${name}`, name: null }) });
  return {
    publishSaleAction: formAction("publish"),
    archiveSaleAction: formAction("archive"),
    reopenSaleAction: formAction("reopen"),
  };
});

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
  // Microsecond precision, exactly as PostgREST returns it.
  updatedAt: "2026-10-14T03:04:05.123456+00:00",
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

  it("never renders internal fields, identity, inline edit or create controls", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, title_key: "internal-key", start_date_jst: "2026-11-05" });

    const html = await render();

    for (const hidden of ["internal-key", "title_key", "start_date_jst", FAKE_CLIENT.user.id, FAKE_CLIENT.user.email]) {
      expect(html).not.toContain(hidden);
    }
    expect(html).not.toMatch(/eyJ|access_token|refresh_token/);
    // The only 作成 is the navigation link to the normal create form
    // (Phase 6Q); no create form or control is rendered here.
    expect(html.match(/作成/g)).toHaveLength(1);
    expect(html).toContain(`href="/admin/new?from=${SALE_ID}">このセールを元に作成</a>`);
    expect(html).not.toContain("新規");
    expect(html).not.toMatch(/<form[^>]*action="[^"]*\/admin\/new/);
    // Editing happens on its own page: the only 編集 here is that link, and
    // no editable field is rendered on the detail page.
    expect(html.match(/編集/g)).toHaveLength(1);
    expect(html).not.toMatch(/<input(?![^>]*type="hidden")|<textarea|<select/);
  });

  it.each([
    ["pending_review", true],
    ["published", true],
    ["rejected", true],
    ["archived", false],
  ])("links to the edit page for %s: %s", async (status, editable) => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, status });
    mocks.getLatestRejectReason.mockResolvedValue("理由");

    const html = await render();

    const link = `<a class="w-full rounded-xl border border-blue-500 bg-white px-4 py-2.5 text-center text-[15px] font-semibold text-blue-600" href="/admin/sales/${SALE_ID}/edit">編集する</a>`;
    if (editable) {
      expect(html).toContain(link);
      // Kept apart from the status actions.
      expect(html.indexOf(link)).toBeLessThan(html.indexOf('aria-label="操作"'));
      expect(actionLabels(html)).not.toContain("編集する");
    } else {
      expect(html).not.toContain("/edit");
      expect(html).not.toContain("編集する");
    }
  });

  it.each(["pending_review", "published", "rejected", "archived"])(
    "offers このセールを元に作成 for a %s sale as a plain link to the prefilled create form",
    async (status) => {
      mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, status });
      mocks.getLatestRejectReason.mockResolvedValue("理由");

      const html = await render();

      const link = `<a class="w-full rounded-xl border border-blue-500 bg-white px-4 py-2.5 text-center text-[15px] font-semibold text-blue-600" href="/admin/new?from=${SALE_ID}">このセールを元に作成</a>`;
      expect(html).toContain(link);
      // Outside every form and apart from the status actions: navigation only.
      const forms = html.match(/<form[^>]*>.*?<\/form>/g) ?? [];
      for (const form of forms) expect(form).not.toContain("このセールを元に作成");
      expect(actionLabels(html)).not.toContain("このセールを元に作成");
    },
  );

  it("confirms a saved edit", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue(SALE);

    expect(await render(SALE_ID, { done: "updated" })).toContain("変更を保存しました");
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

  it.each([
    ["pending_review", "publish", "公開する"],
    ["published", "archive", "終了する"],
    ["rejected", "reopen", "確認待ちに戻す"],
  ])("posts %s's action through its own form with a pending-aware submit button", async (status, action, label) => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, status });
    mocks.getLatestRejectReason.mockResolvedValue("理由");

    const html = await render();
    const forms = html.match(/<form[^>]*>.*?<\/form>/g) ?? [];

    expect(forms).toHaveLength(1);
    expect(forms[0]).toContain(`<form action="/__action/${action}">`);
    expect(forms[0]).toContain(`name="saleId" value="${SALE_ID}"`);
    // The page version goes back unchanged (raw string, microseconds intact).
    expect(forms[0]).toContain('name="expectedUpdatedAt" value="2026-10-14T03:04:05.123456+00:00"');
    expect(forms[0]).toMatch(new RegExp(`<button type="submit" aria-busy="false" class="[^"]*">${label}</button>`));
  });

  it("explains a stale transition and shows the reloaded sale", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, title: "最新のタイトル" });

    const html = await render(SALE_ID, { error: "stale" });

    expect(html).toContain(
      "このセールは別の画面ですでに更新されています。最新の内容を確認してからもう一度操作してください",
    );
    expect(html).not.toContain("操作を完了できませんでした");
    expect(html).toContain("最新のタイトル");
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
    ["created", "登録しました"],
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
    expect(html).not.toContain("別の画面ですでに更新されています");
  });
});

describe("AdminSaleDetailPage past-end warning", () => {
  // SALE runs 2026-11-04T11:00Z to 2026-11-10T17:00Z (exclusive end).
  const ENDED_AT = "2026-11-10T17:00:00Z";
  const BEFORE_END = "2026-11-10T16:59:59.999Z";

  async function renderAt(now: string, overrides: Record<string, unknown>) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, ...overrides });
    mocks.getLatestRejectReason.mockResolvedValue(null);
    try {
      return await render();
    } finally {
      vi.useRealTimers();
    }
  }

  it("flags a published sale whose stored end has passed, keeping 終了する", async () => {
    const html = await renderAt(ENDED_AT, { status: "published" });

    expect(html).toContain('data-past-end="true"');
    expect(html).toContain("期間切れ");
    expect(html).toContain('data-past-end-notice="published"');
    expect(html).toContain("公開ページでは「終了しました」と表示されています");
    expect(html).toContain("必要に応じて「終了する」を押してください");
    expect(actionLabels(html)).toEqual(["終了する"]);
    expect(html).toContain("編集する");
  });

  it("flags a pending sale whose stored end has passed, keeping 公開する and 却下する", async () => {
    const html = await renderAt(ENDED_AT, { status: "pending_review", publishedAt: null });

    expect(html).toContain("期間切れ");
    expect(html).toContain('data-past-end-notice="pending_review"');
    expect(html).toContain("このまま公開すると、公開ページでは「終了しました」と表示されます");
    expect(html).toContain("期間を確認してください");
    expect(actionLabels(html)).toEqual(["公開する", "却下する"]);
  });

  it.each([
    ["published", { status: "published" }],
    ["pending_review", { status: "pending_review", publishedAt: null }],
  ])("does not flag a %s sale one millisecond before its end", async (_label, overrides) => {
    const html = await renderAt(BEFORE_END, overrides);

    expect(html).not.toContain("期間切れ");
    expect(html).not.toContain("data-past-end-notice");
  });

  it.each([
    ["rejected", { status: "rejected", publishedAt: null, rejectedAt: "2026-11-02T00:00:00Z" }],
    ["archived", { status: "archived", archivedAt: "2026-11-11T00:00:00Z" }],
  ])("does not flag a %s sale after its end", async (_label, overrides) => {
    const html = await renderAt("2026-12-01T00:00:00Z", overrides);

    expect(html).not.toContain("期間切れ");
    expect(html).not.toContain("data-past-end-notice");
  });
});

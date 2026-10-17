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
    getAdminSaleEventForEdit: vi.fn(),
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
vi.mock("@/server/data/admin-sale-edit", () => ({ getAdminSaleEventForEdit: mocks.getAdminSaleEventForEdit }));
// Each mocked Server Action renders as a distinct form URL (React's
// $$FORM_ACTION hook; name: null adds no hidden field), so a test can tell
// which action a form is wired to.
vi.mock("./actions", () => ({
  updateSaleAction: Object.assign(vi.fn(), { $$FORM_ACTION: () => ({ action: "/__action/update", name: null }) }),
}));

const { default: AdminSaleEditPage } = await import("./page");

const SALE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const FAKE_CLIENT = { user: { id: "00000000-0000-4000-8000-0000000000aa", email: "admin@example.invalid" } };
const UPDATED_AT = "2026-10-14T03:04:05.123456+00:00";

const SALE = {
  id: SALE_ID,
  status: "pending_review",
  title: "プライム感謝祭 先行セール",
  description: "先行セール",
  startsAt: "2026-10-12T15:00:00+00:00", // 10/13 00:00 JST
  endsAt: "2026-10-15T14:59:00+00:00", // 10/15 23:59 JST
  isDateOnly: false,
  sourceUrl: "https://www.amazon.co.jp/fmc/prime",
  sourceCheckedAt: "2026-10-12T01:00:00+00:00", // 10/12 10:00 JST
  updatedAt: UPDATED_AT,
  retailer: {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "amazon",
    name: "Amazon",
    officialBaseUrl: "https://www.amazon.co.jp/",
  },
};

type Query = Record<string, string | string[] | undefined>;

async function render(query: Query = {}, saleId = SALE_ID) {
  return renderToStaticMarkup(
    await AdminSaleEditPage({ params: Promise.resolve({ saleId }), searchParams: Promise.resolve(query) }),
  );
}

// The value of the <input> with this name, whatever the attribute order.
function inputValue(html: string, name: string): string | undefined {
  const tag = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
  return tag?.match(/value="([^"]*)"/)?.[1];
}

beforeEach(() => {
  mocks.connection.mockResolvedValue(undefined);
  mocks.requireAdmin.mockResolvedValue(FAKE_CLIENT);
  mocks.getAdminSaleEventForEdit.mockResolvedValue(SALE);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [mocks.connection, mocks.requireAdmin, mocks.getAdminSaleEventForEdit]) mock.mockReset();
  mocks.notFound.mockClear();
  mocks.redirect.mockClear();
});

describe("AdminSaleEditPage", () => {
  it("requires an admin before reading the sale", async () => {
    const order: string[] = [];
    mocks.connection.mockImplementation(async () => {
      order.push("connection");
    });
    mocks.requireAdmin.mockImplementation(async () => {
      order.push("requireAdmin");
      return FAKE_CLIENT;
    });
    mocks.getAdminSaleEventForEdit.mockImplementation(async () => {
      order.push("read");
      return SALE;
    });

    await render();

    expect(order).toEqual(["connection", "requireAdmin", "read"]);
    expect(mocks.getAdminSaleEventForEdit).toHaveBeenCalledWith(FAKE_CLIENT, SALE_ID);
  });

  it.each(["/admin/login", "/admin/login?error=1"])("reads nothing for visitors who are not admins (%s)", async (url) => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect(url));

    await expect(render()).rejects.toMatchObject({ url });
    expect(mocks.getAdminSaleEventForEdit).not.toHaveBeenCalled();
  });

  it("prefills the current values in the registration field order", async () => {
    const html = await render();

    expect(html).toContain("セールを編集");
    expect(html).toContain(`name="saleId" value="${SALE_ID}"`);
    expect(html).toContain('name="mode" value="datetime"');
    expect(html).toContain(`name="expectedUpdatedAt" value="${UPDATED_AT}"`);
    expect(html).toContain('value="プライム感謝祭 先行セール"');
    expect(html).toContain(">先行セール</textarea>");
    expect(inputValue(html, "startsAt")).toBe("2026-10-13T00:00");
    expect(inputValue(html, "endsAt")).toBe("2026-10-15T23:59");
    expect(html).toContain('value="https://www.amazon.co.jp/fmc/prime"');
    expect(inputValue(html, "sourceCheckedAt")).toBe("2026-10-12T10:00");
    const order = ["店舗", 'name="title"', 'name="description"', "期間の種類", 'name="startsAt"', 'name="endsAt"', 'name="sourceUrl"', 'name="sourceCheckedAt"'];
    const positions = order.map((marker) => html.indexOf(marker));
    expect(positions.every((position) => position > -1)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  it("shows the retailer read-only and never offers retailer or status fields", async () => {
    const html = await render();

    expect(html).toContain('data-retailer-readonly="true"');
    expect(html).toContain("Amazon");
    expect(html).not.toContain('name="retailerId"');
    expect(html).not.toContain('name="status"');
    expect(html).not.toContain("<select");
  });

  it("offers save and a way back without saving", async () => {
    const html = await render();

    expect(html).toContain(">変更を保存</button>");
    expect(html).toMatch(new RegExp(`href="/admin/sales/${SALE_ID}"[^>]*>変更せず戻る</a>`));
    expect(html.match(/<form/g)).toHaveLength(1);
    // The update action, with the pending-aware submit button.
    expect(html).toMatch(/<form [^>]*action="\/__action\/update"/);
    expect(html).toMatch(/<button type="submit" aria-busy="false" class="[^"]*">変更を保存<\/button>/);
  });

  it("switches between date-only and timed entry on the edit page", async () => {
    const html = await render({ mode: "date" });

    expect(html).toContain(`href="/admin/sales/${SALE_ID}/edit?mode=datetime"`);
    expect(inputValue(html, "startDate")).toBe("2026-10-13");
    expect(inputValue(html, "endDate")).toBe("2026-10-15");
  });

  it("opens a date-only sale in date mode", async () => {
    mocks.getAdminSaleEventForEdit.mockResolvedValue({
      ...SALE,
      isDateOnly: true,
      endsAt: "2026-10-15T15:00:00+00:00",
    });

    const html = await render();

    expect(html).toContain('name="mode" value="date"');
    expect(inputValue(html, "endDate")).toBe("2026-10-15");
  });

  it("warns about a published sale and requires the confirmation checkbox", async () => {
    mocks.getAdminSaleEventForEdit.mockResolvedValue({ ...SALE, status: "published" });

    const html = await render();

    expect(html).toContain("このセールは現在公開中です。変更を保存すると、一般公開中の内容もすぐに更新されます。");
    const checkbox = html.match(/<input[^>]*name="confirmPublished"[^>]*>/)?.[0] ?? "";
    expect(checkbox).toContain('type="checkbox"');
    expect(checkbox).toContain('value="on"');
    expect(checkbox).toContain('required=""');
    expect(html).toContain("公開中の内容が変更されることを確認しました");
  });

  it.each(["pending_review", "rejected"])("shows no published warning for %s", async (status) => {
    mocks.getAdminSaleEventForEdit.mockResolvedValue({ ...SALE, status });

    const html = await render();

    expect(html).not.toContain('data-published-warning="true"');
    expect(html).not.toContain('name="confirmPublished"');
    expect(html).toContain('name="title"');
  });

  it("does not offer a form for an archived sale", async () => {
    mocks.getAdminSaleEventForEdit.mockResolvedValue({ ...SALE, status: "archived" });

    const html = await render();

    expect(html).toContain("終了済みのセールは編集できません");
    expect(html).not.toContain("<form");
    expect(html).toContain(`href="/admin/sales/${SALE_ID}"`);
  });

  it("returns 404 for a missing sale and a generic error when loading fails", async () => {
    mocks.getAdminSaleEventForEdit.mockResolvedValue(null);
    await expect(render()).rejects.toBe(mocks.NOT_FOUND);

    mocks.getAdminSaleEventForEdit.mockRejectedValue(new Error("db detail"));
    const html = await render();
    expect(html).toContain("セール情報を読み込めませんでした");
    expect(html).not.toContain("db detail");
  });

  it.each([
    ["duplicate", "同じ店舗・タイトル・開始日のセールがすでにあります"],
    ["stale", "このセールは別の画面ですでに更新されています。最新の内容を確認してからもう一度編集してください"],
    ["confirm_published", "公開中の内容が変更されることを確認してから保存してください"],
    ["source_domain", "公式ページURLがこのセールの店舗の公式サイトではありません"],
    ["checked_at_not_newer", "公式ページURLを変更した場合は、情報を確認した日時も新しい日時に更新してください"],
    ["not_editable", "終了済みのセールは編集できません"],
    ["failed", "保存できませんでした"],
  ])("shows the fixed message for %s and keeps the saved values", async (error, message) => {
    const html = await render({ error });

    expect(html).toContain(message);
    // Not an empty form: the stored values are shown again.
    expect(html).toContain('value="プライム感謝祭 先行セール"');
  });

  it("never echoes unknown query values", async () => {
    const html = await render({ error: "<script>x</script>", mode: "evil" });

    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("evil");
  });
});

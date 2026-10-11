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
    listActiveRetailersForAdmin: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new RedirectSentinel(url);
    }),
    REDIRECT: RedirectSentinel,
  };
});

vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth/admin-session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/server/data/admin-sale-create", () => ({
  listActiveRetailersForAdmin: mocks.listActiveRetailersForAdmin,
}));
vi.mock("./actions", () => ({ createSaleCandidateAction: vi.fn() }));

const { default: AdminNewSalePage } = await import("./page");

const CLIENT = { user: { id: "00000000-0000-4000-8000-0000000000aa", email: "admin@example.invalid" } };
const RETAILERS = [
  { id: "11111111-1111-4111-8111-111111111111", slug: "rakuten", name: "楽天市場", officialBaseUrl: "https://www.rakuten.co.jp/" },
  { id: "22222222-2222-4222-8222-222222222222", slug: "amazon", name: "Amazon", officialBaseUrl: "https://www.amazon.co.jp/" },
];

function props(query: Record<string, string | string[] | undefined> = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(query) };
}

async function render(query: Record<string, string | string[] | undefined> = {}) {
  return renderToStaticMarkup(await AdminNewSalePage(props(query)));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-11T00:30:00Z")); // 09:30 JST
  mocks.connection.mockResolvedValue(undefined);
  mocks.requireAdmin.mockResolvedValue(CLIENT);
  mocks.listActiveRetailersForAdmin.mockResolvedValue(RETAILERS);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const mock of [mocks.connection, mocks.requireAdmin, mocks.listActiveRetailersForAdmin]) mock.mockReset();
  mocks.redirect.mockClear();
});

describe("AdminNewSalePage", () => {
  it("requires an admin before reading retailers", async () => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login"));

    await expect(AdminNewSalePage(props())).rejects.toBeInstanceOf(mocks.REDIRECT);
    expect(mocks.listActiveRetailersForAdmin).not.toHaveBeenCalled();
  });

  it("lists active retailers with the admin client", async () => {
    const html = await render();

    expect(mocks.listActiveRetailersForAdmin).toHaveBeenCalledWith(CLIENT);
    expect(html).toContain(`value="${RETAILERS[0].id}">楽天市場</option>`);
    expect(html).toContain(`value="${RETAILERS[1].id}">Amazon</option>`);
  });

  it("defaults to date-only mode with inclusive end date fields", async () => {
    const html = await render();

    expect(html).toContain('name="mode" value="date"');
    expect(html).toMatch(/type="date"[^>]*name="startDate"/);
    expect(html).toMatch(/type="date"[^>]*name="endDate"/);
    expect(html).toContain("終了日（この日を含む）");
    expect(html).not.toContain('name="startsAt"');
    expect(html).toMatch(/<a aria-current="page"[^>]*href="\/admin\/new\?mode=date"/);
  });

  it.each([["datetime"], [undefined]])("switches to timed fields only for mode=datetime (%s)", async (mode) => {
    const html = await render({ mode });

    if (mode === "datetime") {
      expect(html).toContain('name="mode" value="datetime"');
      expect(html).toMatch(/type="datetime-local"[^>]*name="startsAt"/);
      expect(html).toMatch(/type="datetime-local"[^>]*name="endsAt"/);
      expect(html).not.toContain('name="startDate"');
    } else {
      expect(html).toContain('name="mode" value="date"');
    }
  });

  it("falls back to date mode for invalid or repeated values", async () => {
    for (const mode of ["time", ["datetime", "datetime"]]) {
      expect(await render({ mode })).toContain('name="mode" value="date"');
    }
  });

  it("has the common fields and a JST default for the checked-at time", async () => {
    const html = await render();

    for (const name of ["retailerId", "title", "description", "sourceUrl", "sourceCheckedAt"]) {
      expect(html).toContain(`name="${name}"`);
    }
    expect(html).toContain("公式ページURL");
    expect(html).toContain("セール情報を確認した公式ページを入力してください");
    expect(html).toContain('value="2026-10-11T09:30"');
    expect(html).toContain("登録する</button>");
  });

  it("never offers status or internal fields", async () => {
    const html = await render();

    for (const name of ["status", "title_key", "start_date_jst", "published_at", "rejected_at", "archived_at"]) {
      expect(html).not.toContain(`name="${name}"`);
    }
    expect(html).not.toContain(CLIENT.user.id);
    expect(html).not.toContain(CLIENT.user.email);
  });

  it.each([
    ["duplicate", "同じセールがすでに登録されています"],
    ["source_domain", "公式ページURLが選んだ店舗の公式サイトではありません"],
    ["period", "期間を正しく入力してください"],
    ["failed", "登録できませんでした"],
  ])("shows the fixed message for error=%s", async (error, message) => {
    expect(await render({ error })).toContain(message);
  });

  it("never echoes unknown error values", async () => {
    const html = await render({ error: '<script>duplicate key "sale_events_active_dedup_uidx"' });

    expect(html).not.toContain("dedup_uidx");
    expect(html).not.toContain('role="alert"');
  });

  it("shows a generic message when retailers cannot be loaded", async () => {
    mocks.listActiveRetailersForAdmin.mockRejectedValue(new Error("secret_detail"));

    const html = await render();

    expect(html).toContain("店舗を読み込めませんでした");
    expect(html).not.toContain("secret_detail");
    expect(html).not.toContain("<form");
  });
});

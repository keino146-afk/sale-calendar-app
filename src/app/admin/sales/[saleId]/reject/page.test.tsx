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
// Each mocked Server Action renders as a distinct form URL (React's
// $$FORM_ACTION hook; name: null adds no hidden field), so a test can tell
// which action a form is wired to.
vi.mock("../actions", () => ({
  rejectSaleAction: Object.assign(vi.fn(), { $$FORM_ACTION: () => ({ action: "/__action/reject", name: null }) }),
}));

const { default: AdminRejectSalePage } = await import("./page");

const SALE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const CLIENT = { fake: "admin client" };
const SALE = {
  id: SALE_ID,
  title: "候補セール",
  description: null,
  startsAt: "2026-10-31T15:00:00Z",
  endsAt: "2026-11-03T15:00:00Z",
  isDateOnly: true,
  status: "pending_review",
  sourceUrl: "https://www.rakuten.co.jp/",
  sourceCheckedAt: null,
  publishedAt: null,
  rejectedAt: null,
  archivedAt: null,
  // Microsecond precision, exactly as PostgREST returns it.
  updatedAt: "2026-10-14T03:04:05.123456+00:00",
  retailer: { slug: "rakuten", name: "楽天市場" },
};

function props(query: Record<string, string> = {}, saleId = SALE_ID) {
  return { params: Promise.resolve({ saleId }), searchParams: Promise.resolve(query) };
}

beforeEach(() => {
  mocks.connection.mockResolvedValue(undefined);
  mocks.requireAdmin.mockResolvedValue(CLIENT);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [mocks.connection, mocks.requireAdmin, mocks.getAdminSaleEvent]) mock.mockReset();
  mocks.notFound.mockClear();
  mocks.redirect.mockClear();
});

describe("AdminRejectSalePage", () => {
  it("requires an admin before reading", async () => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login"));

    await expect(AdminRejectSalePage(props())).rejects.toBeInstanceOf(mocks.REDIRECT);
    expect(mocks.getAdminSaleEvent).not.toHaveBeenCalled();
  });

  it("shows the reason form for a pending sale", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue(SALE);

    const html = renderToStaticMarkup(await AdminRejectSalePage(props()));

    expect(mocks.getAdminSaleEvent).toHaveBeenCalledWith(CLIENT, SALE_ID);
    expect(html).toContain("候補セール");
    expect(html).toContain("却下理由");
    expect(html).toContain('<textarea name="reason" required="" maxLength="2000"');
    expect(html).toContain(`name="saleId" value="${SALE_ID}"`);
    // The version this page shows, sent back unchanged with the rejection.
    expect(html).toContain('name="expectedUpdatedAt" value="2026-10-14T03:04:05.123456+00:00"');
    expect(html).toContain("却下を確定する</button>");
    expect(html).toMatch(/<form [^>]*action="\/__action\/reject"/);
    expect(html).toMatch(/<button type="submit" aria-busy="false" class="[^"]*">却下を確定する<\/button>/);
    expect(html).toContain(`href="/admin/sales/${SALE_ID}"`);
    expect(html).toContain("戻る");
    expect(html).not.toContain('role="alert"');
  });

  it("shows the validation message after an invalid reason", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue(SALE);

    const html = renderToStaticMarkup(await AdminRejectSalePage(props({ error: "reason" })));

    expect(html).toContain("却下理由を2000文字以内で入力してください");
  });

  it.each(["published", "rejected", "archived"])("offers no form for a %s sale", async (status) => {
    mocks.getAdminSaleEvent.mockResolvedValue({ ...SALE, status });

    const html = renderToStaticMarkup(await AdminRejectSalePage(props()));

    expect(html).toContain("このセールは却下できません");
    expect(html).not.toContain("<form");
  });

  it("returns 404 for a missing sale or malformed id", async () => {
    mocks.getAdminSaleEvent.mockResolvedValue(null);

    await expect(AdminRejectSalePage(props({}, "not-a-uuid"))).rejects.toBe(mocks.NOT_FOUND);
  });

  it("shows a generic error when loading fails", async () => {
    mocks.getAdminSaleEvent.mockRejectedValue(new Error("secret_detail"));

    const html = renderToStaticMarkup(await AdminRejectSalePage(props()));

    expect(html).toContain("セール情報を読み込めませんでした");
    expect(html).not.toContain("secret_detail");
  });
});

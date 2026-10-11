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
    listCollectionCandidates: vi.fn(),
    getCollectionCandidate: vi.fn(),
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
vi.mock("@/server/data/admin-collection-candidates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/data/admin-collection-candidates")>();
  return {
    ...actual,
    listCollectionCandidates: mocks.listCollectionCandidates,
    getCollectionCandidate: mocks.getCollectionCandidate,
  };
});

const { default: ListPage } = await import("./page");
const { default: DetailPage } = await import("./[candidateId]/page");

const CLIENT = { user: { id: "00000000-0000-4000-8000-0000000000aa", email: "admin@example.invalid" } };
const ID = "55555555-5555-4555-8555-555555555555";

const SUMMARY = {
  id: ID,
  title: "プライム感謝祭",
  startsAt: "2026-10-15T15:00:00Z",
  endsAt: "2026-10-19T14:59:00Z",
  isDateOnly: false,
  reviewState: "new",
  sourceChanged: false,
  firstSeenAt: "2026-10-01T00:00:00Z",
  lastSeenAt: "2026-10-02T03:00:00Z",
  retailer: { id: "22222222-2222-4222-8222-222222222222", slug: "amazon", name: "Amazon" },
};

const DETAIL = {
  ...SUMMARY,
  description: "プライム会員限定",
  sourceUrl: "https://www.aboutamazon.jp/news/prime-sale",
  sourceCheckedAt: "2026-10-02T03:00:00Z",
  evidenceExcerpt: "Amazon、プライム感謝祭を10月16日（金）0時から10月19日（月）23時59分まで開催",
  parserVersion: "amazon-rss-1",
  importedSaleEventId: null,
};

function listProps(query: Record<string, string | string[] | undefined> = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(query) };
}

function detailProps(candidateId = ID) {
  return { params: Promise.resolve({ candidateId }), searchParams: Promise.resolve({}) };
}

beforeEach(() => {
  mocks.connection.mockResolvedValue(undefined);
  mocks.requireAdmin.mockResolvedValue(CLIENT);
  mocks.listCollectionCandidates.mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [mocks.connection, mocks.requireAdmin, mocks.listCollectionCandidates, mocks.getCollectionCandidate]) {
    mock.mockReset();
  }
  mocks.notFound.mockClear();
  mocks.redirect.mockClear();
});

describe("AdminCollectionPage", () => {
  it("requires an admin before reading", async () => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login"));

    await expect(ListPage(listProps())).rejects.toBeInstanceOf(mocks.REDIRECT);
    expect(mocks.listCollectionCandidates).not.toHaveBeenCalled();
  });

  it("shows the empty state explaining collection is not active yet", async () => {
    const html = renderToStaticMarkup(await ListPage(listProps()));

    expect(mocks.listCollectionCandidates).toHaveBeenCalledWith(CLIENT, { reviewState: "new" });
    expect(mocks.listCollectionCandidates).toHaveBeenCalledTimes(1);
    expect(html).toContain("収集候補");
    expect(html).toContain("収集候補はありません");
    expect(html).toContain("自動収集で見つかったセール候補がここに表示されます");
    expect(html).toContain("自動収集はまだ有効になっていません");
    expect(html).toContain('href="/admin"');
  });

  it("filters by review state, defaulting to new", async () => {
    await ListPage(listProps({ state: "dismissed" }));
    expect(mocks.listCollectionCandidates).toHaveBeenLastCalledWith(CLIENT, { reviewState: "dismissed" });
    await ListPage(listProps({ state: "published" }));
    expect(mocks.listCollectionCandidates).toHaveBeenLastCalledWith(CLIENT, { reviewState: "new" });
  });

  it("lists candidates with retailer, period, state, change flag and detail link", async () => {
    mocks.listCollectionCandidates.mockResolvedValue([SUMMARY, { ...SUMMARY, id: "66666666-6666-4666-8666-666666666666", sourceChanged: true }]);

    const html = renderToStaticMarkup(await ListPage(listProps()));

    expect(html).toContain(`href="/admin/collection/${ID}"`);
    expect(html).toContain("Amazon");
    expect(html).toContain("プライム感謝祭");
    expect(html).toContain("10/16 00:00 〜 10/19 23:59");
    expect(html).toContain("未確認");
    expect(html.match(/data-source-changed="true"/g)).toHaveLength(1);
    expect(html).toContain("初回 2026/10/1 09:00");
    expect(html).toContain("最終 2026/10/2 12:00");
  });

  it("shows a generic error without details", async () => {
    mocks.listCollectionCandidates.mockRejectedValue(new Error("secret_detail"));

    const html = renderToStaticMarkup(await ListPage(listProps()));

    expect(html).toContain("収集候補を読み込めませんでした");
    expect(html).not.toContain("secret_detail");
  });

  it("offers no mutation controls", async () => {
    mocks.listCollectionCandidates.mockResolvedValue([SUMMARY]);
    const html = renderToStaticMarkup(await ListPage(listProps()));
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<button");
  });
});

describe("AdminCollectionCandidatePage", () => {
  it("requires an admin before reading", async () => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login"));

    await expect(DetailPage(detailProps())).rejects.toBeInstanceOf(mocks.REDIRECT);
    expect(mocks.getCollectionCandidate).not.toHaveBeenCalled();
  });

  it("shows review details, evidence and a safe official link", async () => {
    mocks.getCollectionCandidate.mockResolvedValue(DETAIL);

    const html = renderToStaticMarkup(await DetailPage(detailProps()));

    expect(mocks.getCollectionCandidate).toHaveBeenCalledWith(CLIENT, ID);
    for (const text of [
      "プライム感謝祭",
      "Amazon",
      "未確認",
      "時刻あり",
      "2026/10/16 00:00",
      "2026/10/19 23:59",
      "プライム会員限定",
      "読み取った根拠",
      DETAIL.evidenceExcerpt,
      "amazon-rss-1",
      "公式情報を確認",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toContain(`href="${DETAIL.sourceUrl}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("data-source-changed");
  });

  it("links to manual registration with only the candidate id", async () => {
    mocks.getCollectionCandidate.mockResolvedValue(DETAIL);

    const html = renderToStaticMarkup(await DetailPage(detailProps()));

    const links = [...html.matchAll(/href="(\/admin\/new[^"]*)"/g)].map(([, href]) => href);
    expect(links).toEqual([`/admin/new?candidateId=${ID}`]);
    expect(html).toContain("手動登録へ進む");
    expect(html).not.toContain("<form");
  });

  it("says registering marks the candidate imported without publishing", async () => {
    mocks.getCollectionCandidate.mockResolvedValue(DETAIL);
    const html = renderToStaticMarkup(await DetailPage(detailProps()));
    expect(html).toContain("登録すると、この候補は「登録済み」になります");
    expect(html).toContain("公開はされません");
    expect(html).not.toContain("この候補の状態は変わりません");
  });

  it("shows an imported candidate as registered with a link to its sale, without re-import", async () => {
    const saleId = "77777777-7777-4777-8777-777777777777";
    mocks.getCollectionCandidate.mockResolvedValue({ ...DETAIL, reviewState: "imported", importedSaleEventId: saleId });

    const html = renderToStaticMarkup(await DetailPage(detailProps()));

    expect(html).toContain('data-candidate-imported="true"');
    expect(html).toContain("登録済み");
    expect(html).toContain(`href="/admin/sales/${saleId}"`);
    expect(html).toContain("登録したセールを見る");
    expect(html).not.toContain("手動登録へ進む");
    expect(html).not.toMatch(/href="\/admin\/new/);
  });

  it("offers no registration for a dismissed candidate", async () => {
    mocks.getCollectionCandidate.mockResolvedValue({ ...DETAIL, reviewState: "dismissed" });

    const html = renderToStaticMarkup(await DetailPage(detailProps()));

    expect(html).toContain('data-candidate-dismissed="true"');
    expect(html).not.toContain("手動登録へ進む");
    expect(html).not.toMatch(/href="\/admin\/(new|sales)/);
  });

  it("warns when the official source changed after collection", async () => {
    mocks.getCollectionCandidate.mockResolvedValue({ ...DETAIL, sourceChanged: true });

    const html = renderToStaticMarkup(await DetailPage(detailProps()));

    expect(html).toContain('data-source-changed="true"');
    expect(html).toContain("収集後に公式情報が変更されています。登録前に公式ページを確認してください。");
  });

  it("renders source text as text, never as HTML", async () => {
    mocks.getCollectionCandidate.mockResolvedValue({ ...DETAIL, evidenceExcerpt: "<script>alert(1)</script>", title: "<b>x</b>" });

    const html = renderToStaticMarkup(await DetailPage(detailProps()));

    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>x</b>");
  });

  it("never renders hashes or identity details", async () => {
    mocks.getCollectionCandidate.mockResolvedValue({ ...DETAIL, contentHash: "a".repeat(64) });

    const html = renderToStaticMarkup(await DetailPage(detailProps()));

    expect(html).not.toContain("a".repeat(64));
    expect(html).not.toContain(CLIENT.user.id);
    expect(html).not.toContain(CLIENT.user.email);
  });

  it.each(["not-a-uuid", ID])("returns 404 when the candidate is not found (%s)", async (id) => {
    mocks.getCollectionCandidate.mockResolvedValue(null);

    await expect(DetailPage(detailProps(id))).rejects.toBe(mocks.NOT_FOUND);
  });

  it("shows a generic error when loading fails", async () => {
    mocks.getCollectionCandidate.mockRejectedValue(new Error("secret_detail"));

    const html = renderToStaticMarkup(await DetailPage(detailProps()));

    expect(html).toContain("収集候補を読み込めませんでした");
    expect(html).not.toContain("secret_detail");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });
});

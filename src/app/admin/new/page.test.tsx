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
    getCollectionCandidate: vi.fn(),
    getAdminSaleEvent: vi.fn(),
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
vi.mock("@/server/data/admin-collection-candidates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/data/admin-collection-candidates")>();
  return { ...actual, getCollectionCandidate: mocks.getCollectionCandidate };
});
vi.mock("@/server/data/admin-sale-events", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/data/admin-sale-events")>();
  return { ...actual, getAdminSaleEvent: mocks.getAdminSaleEvent };
});
// Each mocked Server Action renders as a distinct form URL (React's
// $$FORM_ACTION hook; name: null adds no hidden field), so a test can tell
// which action a form is wired to.
vi.mock("./actions", () => ({
  createSaleCandidateAction: Object.assign(vi.fn(), {
    $$FORM_ACTION: () => ({ action: "/__action/create", name: null }),
  }),
}));

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
  mocks.getCollectionCandidate.mockReset();
  mocks.getAdminSaleEvent.mockReset();
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
    expect(html).toMatch(/<form [^>]*action="\/__action\/create"/);
    expect(html).toMatch(/<button type="submit" aria-busy="false" class="[^"]*">登録する<\/button>/);
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

  describe("prefill from a collection candidate", () => {
    const CANDIDATE_ID = "55555555-5555-4555-8555-555555555555";
    const CANDIDATE = {
      id: CANDIDATE_ID,
      title: "プライム感謝祭",
      description: "プライム会員限定",
      startsAt: "2026-10-15T15:00:00Z", // 10/16 00:00 JST
      endsAt: "2026-10-19T14:59:00Z", // 10/19 23:59 JST
      isDateOnly: false,
      reviewState: "new",
      sourceChanged: false,
      firstSeenAt: "2026-10-01T00:00:00Z",
      lastSeenAt: "2026-10-02T00:00:00Z",
      sourceUrl: "https://www.amazon.co.jp/primeday",
      sourceCheckedAt: "2026-10-02T03:00:00Z", // 12:00 JST
      evidenceExcerpt: "根拠",
      parserVersion: "amazon-rss-1",
      importedSaleEventId: null,
      retailer: { id: RETAILERS[1].id, slug: "amazon", name: "Amazon" },
    };

    it("looks the candidate up server-side and prefills a timed form", async () => {
      mocks.getCollectionCandidate.mockResolvedValue(CANDIDATE);

      const html = await render({ candidateId: CANDIDATE_ID });

      expect(mocks.getCollectionCandidate).toHaveBeenCalledWith(CLIENT, CANDIDATE_ID);
      expect(html).toContain('data-prefilled-from-candidate="true"');
      expect(html).toContain('name="mode" value="datetime"');
      expect(html).toContain(`name="candidateId" value="${CANDIDATE_ID}"`);
      expect(html).toContain(`<option value="${RETAILERS[1].id}" selected="">Amazon</option>`);
      expect(html).toMatch(/value="プライム感謝祭"[^>]*name="title"|name="title"[^>]*value="プライム感謝祭"/);
      expect(html).toContain(">プライム会員限定</textarea>");
      expect(html).toMatch(/name="startsAt"[^>]*value="2026-10-16T00:00"/);
      expect(html).toMatch(/name="endsAt"[^>]*value="2026-10-19T23:59"/);
      expect(html).toMatch(/name="sourceUrl"[^>]*value="https:\/\/www\.amazon\.co\.jp\/primeday"/);
      expect(html).toMatch(/name="sourceCheckedAt"[^>]*value="2026-10-02T12:00"/);
      // Mode links keep the candidate.
      expect(html).toContain(`href="/admin/new?mode=date&amp;candidateId=${CANDIDATE_ID}"`);
      // An import posts through the same action and pending-aware button.
      expect(html).toMatch(/<form [^>]*action="\/__action\/create"/);
      expect(html).toMatch(/<button type="submit" aria-busy="false" class="[^"]*">登録する<\/button>/);
    });

    it("prefills date fields with the inclusive last day", async () => {
      mocks.getCollectionCandidate.mockResolvedValue({
        ...CANDIDATE,
        isDateOnly: true,
        startsAt: "2026-10-10T15:00:00Z", // 10/11 00:00 JST
        endsAt: "2026-10-13T15:00:00Z", // exclusive 10/14 00:00 JST
      });

      const html = await render({ candidateId: CANDIDATE_ID });

      expect(html).toContain('name="mode" value="date"');
      expect(html).toMatch(/name="startDate"[^>]*value="2026-10-11"/);
      expect(html).toMatch(/name="endDate"[^>]*value="2026-10-13"/);
    });

    it("lets an explicit mode override the candidate's period type", async () => {
      mocks.getCollectionCandidate.mockResolvedValue(CANDIDATE);

      const html = await render({ candidateId: CANDIDATE_ID, mode: "date" });

      expect(html).toContain('name="mode" value="date"');
      expect(html).toMatch(/name="startDate"[^>]*value="2026-10-16"/);
      expect(html).toMatch(/name="endDate"[^>]*value="2026-10-19"/);
    });

    it("warns when the source changed after collection", async () => {
      mocks.getCollectionCandidate.mockResolvedValue({ ...CANDIDATE, sourceChanged: true });

      const html = await render({ candidateId: CANDIDATE_ID });

      expect(html).toContain("収集後に公式情報が変更されています");
    });

    it("leaves the retailer unselected when the candidate's retailer is inactive", async () => {
      mocks.getCollectionCandidate.mockResolvedValue({
        ...CANDIDATE,
        retailer: { id: "99999999-9999-4999-8999-999999999999", slug: "old", name: "Old" },
      });

      const html = await render({ candidateId: CANDIDATE_ID });

      expect(html).toContain('<option value="" disabled="" selected="">');
    });

    it.each(["not-a-uuid", ["x", "y"], ""])("ignores a malformed candidate id without querying (%j)", async (candidateId) => {
      const html = await render({ candidateId });

      expect(mocks.getCollectionCandidate).not.toHaveBeenCalled();
      expect(html).not.toContain("data-prefilled-from-candidate");
      expect(html).not.toContain('name="candidateId"');
      expect(html).not.toContain("収集候補を読み込めませんでした");
    });

    it("shows a generic notice and an empty form for a missing or unreadable candidate", async () => {
      mocks.getCollectionCandidate.mockResolvedValue(null);
      const missing = await render({ candidateId: CANDIDATE_ID });
      expect(missing).toContain("収集候補を読み込めませんでした");
      expect(missing).not.toContain('name="candidateId"');

      mocks.getCollectionCandidate.mockRejectedValue(new Error("secret_detail"));
      const failing = await render({ candidateId: CANDIDATE_ID });
      expect(failing).toContain("収集候補を読み込めませんでした");
      expect(failing).not.toContain("secret_detail");
    });

    it.each(["imported", "dismissed"])("does not offer a %s candidate for registration", async (reviewState) => {
      mocks.getCollectionCandidate.mockResolvedValue({ ...CANDIDATE, reviewState });
      const html = await render({ candidateId: CANDIDATE_ID });
      expect(html).toContain('data-candidate-closed="true"');
      expect(html).toContain("この収集候補はすでに登録済みか、見送り済みです");
      expect(html).not.toContain('name="candidateId"');
      expect(html).not.toContain("data-prefilled-from-candidate");
      expect(html).not.toContain("プライム感謝祭");
    });

    it("shows a fixed message when the import found the candidate already taken", async () => {
      mocks.getCollectionCandidate.mockResolvedValue(CANDIDATE);
      const html = await render({ candidateId: CANDIDATE_ID, error: "candidate_state" });
      expect(html).toContain("この収集候補はすでに登録済みか、登録できない状態です");
    });

    it("does not query candidates without a candidate id", async () => {
      await render();
      expect(mocks.getCollectionCandidate).not.toHaveBeenCalled();
    });
  });

  describe("prefill from a previous sale (from=)", () => {
    const SOURCE_ID = "77777777-7777-4777-8777-777777777777";
    const SOURCE = {
      id: SOURCE_ID,
      title: "楽天スーパーSALE",
      description: "最大半額",
      startsAt: "2026-09-03T15:00:00+00:00",
      endsAt: "2026-09-10T15:00:00+00:00",
      isDateOnly: true,
      status: "archived",
      sourceUrl: "https://event.rakuten.co.jp/campaign/supersale/",
      sourceCheckedAt: "2026-08-20T00:00:00+00:00",
      publishedAt: "2026-08-21T00:00:00+00:00",
      rejectedAt: null,
      archivedAt: "2026-09-12T00:00:00+00:00",
      updatedAt: "2026-09-12T00:00:00.123456+00:00",
      retailer: { slug: "rakuten", name: "楽天市場" },
    };
    const NOTICE = "過去のセール情報を元に入力しています。開催期間は空欄です。公式ページで内容を確認し、新しい期間を入力してから登録してください。";
    const UNAVAILABLE = "元のセールを読み込めませんでした";
    const inputValue = (html: string, name: string) =>
      html.match(new RegExp(`<(?:input|textarea)[^>]*name="${name}"[^>]*>`))?.[0].match(/value="([^"]*)"/)?.[1] ?? "";

    it("reads the sale server-side and prefills only the reusable content, with an empty period", async () => {
      mocks.getAdminSaleEvent.mockResolvedValue(SOURCE);

      const html = await render({ from: SOURCE_ID });

      expect(mocks.getAdminSaleEvent).toHaveBeenCalledWith(CLIENT, SOURCE_ID);
      expect(html).toContain(NOTICE);
      expect(html).toContain('data-prefilled-from-previous-sale="true"');
      expect(html).toContain(`<option value="${RETAILERS[0].id}" selected="">楽天市場</option>`);
      expect(inputValue(html, "title")).toBe("楽天スーパーSALE");
      expect(html).toContain(">最大半額</textarea>");
      expect(inputValue(html, "sourceUrl")).toBe("https://event.rakuten.co.jp/campaign/supersale/");
      // Date-only source: the date form, both dates empty.
      expect(html).toContain('name="mode" value="date"');
      expect(inputValue(html, "startDate")).toBe("");
      expect(inputValue(html, "endDate")).toBe("");
      // Checked time is now (09:30 JST), as on a blank form.
      expect(inputValue(html, "sourceCheckedAt")).toBe("2026-10-11T09:30");
      expect(html).not.toContain(UNAVAILABLE);
    });

    it("prefills a timed sale in datetime mode with both times empty", async () => {
      mocks.getAdminSaleEvent.mockResolvedValue({ ...SOURCE, isDateOnly: false });

      const html = await render({ from: SOURCE_ID });

      expect(html).toContain('name="mode" value="datetime"');
      expect(inputValue(html, "startsAt")).toBe("");
      expect(inputValue(html, "endsAt")).toBe("");
    });

    it("submits through the normal create form without the source id, status or version", async () => {
      mocks.getAdminSaleEvent.mockResolvedValue(SOURCE);

      const html = await render({ from: SOURCE_ID });
      const form = html.match(/<form[^>]*>.*?<\/form>/)?.[0] ?? "";

      expect(form).toMatch(/<form [^>]*action="\/__action\/create"/);
      const hidden = [...form.matchAll(/<input type="hidden" name="([^"]+)"/g)].map(([, name]) => name);
      expect(hidden).toEqual(["mode"]);
      // The period-type links keep from= (navigation only, never submitted);
      // nothing that is submitted carries the source.
      const submitted = form.replace(/<a [^>]*>.*?<\/a>/g, "");
      for (const leaked of [SOURCE_ID, "archived", SOURCE.updatedAt, "expectedUpdatedAt", 'name="from"', 'name="status"']) {
        expect(submitted).not.toContain(leaked);
      }
    });

    it("leaves the retailer unselected when it is no longer active", async () => {
      mocks.getAdminSaleEvent.mockResolvedValue({ ...SOURCE, retailer: { slug: "qoo10", name: "Qoo10" } });

      const html = await render({ from: SOURCE_ID });

      expect(html).toContain('<option value="" disabled="" selected="">選んでください</option>');
      expect(html).toContain(NOTICE);
    });

    it("keeps the previous sale when switching between date and datetime entry", async () => {
      mocks.getAdminSaleEvent.mockResolvedValue(SOURCE);

      const html = await render({ from: SOURCE_ID });

      expect(html).toContain(`href="/admin/new?mode=date&amp;from=${SOURCE_ID}"`);
      expect(html).toContain(`href="/admin/new?mode=datetime&amp;from=${SOURCE_ID}"`);
    });

    it("lets an explicit mode override the source's period type", async () => {
      mocks.getAdminSaleEvent.mockResolvedValue(SOURCE);

      const html = await render({ from: SOURCE_ID, mode: "datetime" });

      expect(html).toContain('name="mode" value="datetime"');
      expect(inputValue(html, "title")).toBe("楽天スーパーSALE");
    });

    it.each(["not-a-uuid", `${SOURCE_ID}x`, "../../etc/passwd"])(
      "ignores a malformed from (%s) without querying: plain blank form",
      async (from) => {
        const html = await render({ from });

        expect(mocks.getAdminSaleEvent).not.toHaveBeenCalled();
        expect(html).not.toContain(NOTICE);
        expect(html).not.toContain(UNAVAILABLE);
        expect(html).not.toContain(from);
        expect(inputValue(html, "title")).toBe("");
      },
    );

    it("shows a fixed notice and a blank form for a missing sale", async () => {
      mocks.getAdminSaleEvent.mockResolvedValue(null);

      const html = await render({ from: SOURCE_ID });

      expect(html).toContain(UNAVAILABLE);
      expect(html).not.toContain(NOTICE);
      expect(inputValue(html, "title")).toBe("");
      expect(html).toContain('<option value="" disabled="" selected="">選んでください</option>');
    });

    it("shows the same fixed notice for a read failure, without the error detail", async () => {
      mocks.getAdminSaleEvent.mockRejectedValue(new Error("PGRST000 secret_detail relation sale_events"));

      const html = await render({ from: SOURCE_ID });

      expect(html).toContain(UNAVAILABLE);
      expect(html).not.toContain("secret_detail");
      expect(html).not.toContain("PGRST000");
      expect(inputValue(html, "title")).toBe("");
      const logged = vi.mocked(console.error).mock.calls.flat().map(String).join(" ");
      expect(logged).toContain("previous sale prefill failed: Error");
      expect(logged).not.toContain("secret_detail");
    });

    it("gives a candidateId precedence: the previous sale is not read or merged", async () => {
      mocks.getCollectionCandidate.mockResolvedValue({
        id: "55555555-5555-4555-8555-555555555555",
        title: "プライム感謝祭",
        description: null,
        startsAt: "2026-10-15T15:00:00Z",
        endsAt: "2026-10-19T14:59:00Z",
        isDateOnly: false,
        reviewState: "new",
        sourceChanged: false,
        firstSeenAt: "2026-10-01T00:00:00Z",
        lastSeenAt: "2026-10-02T00:00:00Z",
        sourceUrl: "https://www.amazon.co.jp/primeday",
        sourceCheckedAt: "2026-10-02T03:00:00Z",
        evidenceExcerpt: "根拠",
        parserVersion: "amazon-rss-1",
        importedSaleEventId: null,
        retailer: { id: RETAILERS[1].id, slug: "amazon", name: "Amazon" },
      });

      const html = await render({ candidateId: "55555555-5555-4555-8555-555555555555", from: SOURCE_ID });

      expect(mocks.getAdminSaleEvent).not.toHaveBeenCalled();
      expect(html).toContain('data-prefilled-from-candidate="true"');
      expect(html).not.toContain(NOTICE);
      expect(inputValue(html, "title")).toBe("プライム感謝祭");
      expect(html).toContain(`href="/admin/new?mode=date&amp;candidateId=55555555-5555-4555-8555-555555555555"`);
      expect(html).not.toContain(`from=${SOURCE_ID}`);
    });

    it("reads nothing and shows no notice without from", async () => {
      const html = await render();

      expect(mocks.getAdminSaleEvent).not.toHaveBeenCalled();
      expect(html).not.toContain(NOTICE);
      expect(html).not.toContain(UNAVAILABLE);
      expect(html).toContain('href="/admin/new?mode=date"');
    });

    it("requires an admin before reading the previous sale", async () => {
      mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login"));

      await expect(AdminNewSalePage(props({ from: SOURCE_ID }))).rejects.toBeInstanceOf(mocks.REDIRECT);
      expect(mocks.getAdminSaleEvent).not.toHaveBeenCalled();
    });
  });
});

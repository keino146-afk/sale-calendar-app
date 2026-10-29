import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connection, listActiveRetailers, listPublishedSaleEvents, getNextPublishedSaleEvent } = vi.hoisted(
  () => ({
    connection: vi.fn(),
    listActiveRetailers: vi.fn(),
    listPublishedSaleEvents: vi.fn(),
    getNextPublishedSaleEvent: vi.fn(),
  }),
);

vi.mock("next/server", () => ({ connection }));
vi.mock("@/server/data/retailers", () => ({ listActiveRetailers }));
vi.mock("@/server/data/sale-events", () => ({ listPublishedSaleEvents, getNextPublishedSaleEvent }));

const { default: Home, generateMetadata } = await import("./page");

// Fake values only; none of these are real credentials or hosts.
const RETAILERS = [
  {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "rakuten",
    name: "楽天市場",
    officialBaseUrl: "https://www.rakuten.co.jp/",
    sortOrder: 10,
  },
  {
    id: "22222222-2222-4222-8222-222222222222",
    slug: "amazon",
    name: "Amazon",
    officialBaseUrl: "https://www.amazon.co.jp/",
    sortOrder: 20,
  },
];

const NOW = new Date("2026-10-10T03:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function makeSale(
  id: string,
  title: string,
  startsAt: string,
  endsAt: string,
  retailer = { slug: "rakuten", name: "楽天市場" },
) {
  return {
    id,
    title,
    description: null,
    startsAt,
    endsAt,
    isDateOnly: false,
    sourceUrl: "https://www.rakuten.co.jp/event/",
    sourceCheckedAt: null,
    publishedAt: "2026-10-01T00:00:00Z",
    retailer,
  };
}

const ACTIVE_SALE = makeSale(
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "開催中セール",
  "2026-10-09T11:00:00Z",
  "2026-10-12T15:00:00Z",
);
const UPCOMING_SALE = makeSale(
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "近日セール",
  "2026-10-15T11:00:00Z",
  "2026-10-16T15:00:00Z",
  { slug: "amazon", name: "Amazon" },
);

function homeProps(params: Record<string, string | string[] | undefined> = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(params) };
}

async function renderHome(params: Record<string, string | string[] | undefined> = {}) {
  return renderToStaticMarkup(await Home(homeProps(params)));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  connection.mockResolvedValue(undefined);
  listActiveRetailers.mockResolvedValue(RETAILERS);
  listPublishedSaleEvents.mockResolvedValue([]);
  getNextPublishedSaleEvent.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  connection.mockReset();
  listActiveRetailers.mockReset();
  listPublishedSaleEvents.mockReset();
  getNextPublishedSaleEvent.mockReset();
});

describe("Home", () => {
  it("waits for a request before reading data, retailers first", async () => {
    const order: string[] = [];
    connection.mockImplementation(async () => {
      order.push("connection");
    });
    listActiveRetailers.mockImplementation(async () => {
      order.push("retailers");
      return RETAILERS;
    });
    listPublishedSaleEvents.mockImplementation(async () => {
      order.push("events");
      return [];
    });

    await renderHome();

    expect(order).toEqual(["connection", "retailers", "events"]);
    expect(listActiveRetailers).toHaveBeenCalledTimes(1);
    expect(listPublishedSaleEvents).toHaveBeenCalledTimes(1);
  });

  it("ends with the public footer (disclaimer and operator)", async () => {
    const html = await renderHome();

    expect(html).toMatch(/<\/main><footer[^>]*>.*最新情報は各公式サイトをご確認ください。.*運営：セールカレンダー運営.*<\/footer>$/);
  });

  it("does not swallow connection() failures", async () => {
    const interrupt = new Error("prerender interrupted");
    connection.mockRejectedValue(interrupt);

    await expect(Home(homeProps())).rejects.toBe(interrupt);
    expect(listActiveRetailers).not.toHaveBeenCalled();
    expect(listPublishedSaleEvents).not.toHaveBeenCalled();
  });

  it("queries a 14-day window from now with no filter by default", async () => {
    await renderHome();

    expect(listPublishedSaleEvents).toHaveBeenCalledWith({
      from: NOW,
      to: new Date(NOW.getTime() + 14 * DAY_MS),
      retailerSlug: undefined,
    });
  });

  it("passes a known retailer filter to the event query", async () => {
    await renderHome({ retailer: "amazon" });

    expect(listPublishedSaleEvents).toHaveBeenCalledWith(
      expect.objectContaining({ retailerSlug: "amazon" }),
    );
  });

  it.each([
    ["unknown slug", { retailer: "qoo10" }],
    ["malformed value", { retailer: "Rakuten,Amazon" }],
    ["repeated parameter", { retailer: ["rakuten", "amazon"] }],
  ])("falls back to all retailers for an %s", async (_label, params) => {
    await renderHome(params);

    expect(listPublishedSaleEvents).toHaveBeenCalledWith(
      expect.objectContaining({ retailerSlug: undefined }),
    );
  });

  it("renders the retailer filter with names and links", async () => {
    const html = await renderHome({ retailer: "amazon" });

    expect(html).toContain("すべて");
    expect(html).toContain("楽天市場");
    expect(html).toContain("Amazon");
    expect(html).toContain('href="/?retailer=rakuten"');
    expect(html).toContain('href="/?retailer=amazon"');
  });

  it("renders active and upcoming sections with detail links", async () => {
    listPublishedSaleEvents.mockResolvedValue([ACTIVE_SALE, UPCOMING_SALE]);

    const html = await renderHome();

    expect(html).toContain("開催中");
    expect(html).toContain("近日開催");
    expect(html).toContain("開催中セール");
    expect(html).toContain("近日セール");
    expect(html).toContain(`href="/sales/${ACTIVE_SALE.id}"`);
    expect(html).toContain(`href="/sales/${UPCOMING_SALE.id}"`);
    expect(html.indexOf("開催中セール")).toBeLessThan(html.indexOf("近日セール"));
  });

  it("shows a timed sale's exclusive end as its last running minute", async () => {
    listPublishedSaleEvents.mockResolvedValue([
      // 2026-10-13 00:00 JST to 2026-10-16 00:00 JST (exclusive)
      makeSale("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "先行セール", "2026-10-12T15:00:00Z", "2026-10-15T15:00:00Z"),
    ]);

    const html = await renderHome();

    expect(html).toContain("10/13 00:00 〜 10/15 23:59");
    expect(html).not.toContain("10/16 00:00");
  });

  it("reserves a spot for the admin-only link without showing it on the server", async () => {
    listPublishedSaleEvents.mockResolvedValue([ACTIVE_SALE, UPCOMING_SALE]);

    const html = await renderHome();

    // The Client Component renders nothing until /admin/presence says admin.
    expect(html).not.toContain("管理画面へ");
    expect(html).not.toContain('href="/admin"');
    const spot = html.indexOf('<div class="absolute right-0 top-0">');
    expect(spot).toBeGreaterThan(html.indexOf("セールカレンダー"));
    expect(spot).toBeLessThan(html.indexOf("カレンダーを見る"));
    // Existing content stays.
    expect(html).toContain('href="/calendar"');
    expect(html).toContain("開催中セール");
    expect(html).toContain("近日セール");
  });

  it("renders empty states", async () => {
    const html = await renderHome();

    expect(html).toContain("現在開催中のセールはありません");
    expect(html).toContain("近日開催予定のセールはありません");
  });

  it("renders a generic error without leaking details and logs only the error name", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listPublishedSaleEvents.mockRejectedValue(
      new Error("sb_secret_FAKE_SHOULD_NOT_APPEAR https://abcdefghijklmnopqrst.supabase.co"),
    );

    const html = await renderHome();

    expect(html).toContain("セール情報を読み込めませんでした");
    expect(html).not.toContain("sb_secret_");
    expect(html).not.toContain("supabase.co");
    expect(html).not.toContain("すべて");
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("sb_secret_");
    expect(logged).not.toContain("supabase.co");
  });

  it("renders a generic error when retailers fail to load", async () => {
    listActiveRetailers.mockRejectedValue(new Error("upstream detail"));

    const html = await renderHome();

    expect(html).toContain("セール情報を読み込めませんでした");
    expect(html).not.toContain("upstream detail");
    expect(listPublishedSaleEvents).not.toHaveBeenCalled();
    expect(getNextPublishedSaleEvent).not.toHaveBeenCalled();
  });

  it("links to the calendar page", async () => {
    const html = await renderHome();

    expect(html).toContain('href="/calendar"');
    expect(html).toContain("カレンダーを見る");
  });
});

describe("Home next-sale hint", () => {
  const IN_14_DAYS = new Date(NOW.getTime() + 14 * DAY_MS);
  const FAR_SALE = makeSale(
    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    "お買い物マラソン",
    "2026-11-04T11:00:00Z",
    "2026-11-11T01:00:00Z",
  );

  it("does not look further when a sale starts within 14 days", async () => {
    listPublishedSaleEvents.mockResolvedValue([ACTIVE_SALE, UPCOMING_SALE]);

    const html = await renderHome();

    expect(getNextPublishedSaleEvent).not.toHaveBeenCalled();
    expect(html).not.toContain("次回開催予定");
  });

  it("shows the first later sale when nothing starts within 14 days", async () => {
    listPublishedSaleEvents.mockResolvedValue([ACTIVE_SALE]);
    getNextPublishedSaleEvent.mockResolvedValue(FAR_SALE);

    const html = await renderHome();

    // The same boundary the upcoming window ends at, from the same now.
    expect(getNextPublishedSaleEvent).toHaveBeenCalledTimes(1);
    expect(getNextPublishedSaleEvent).toHaveBeenCalledWith({ after: IN_14_DAYS, retailerSlug: undefined });
    expect(html).toContain("近日開催予定のセールはありません");
    expect(html).toContain("次回開催予定");
    expect(html).toContain("お買い物マラソン");
    expect(html).toContain(`href="/sales/${FAR_SALE.id}"`);
    expect(html).toContain("11/4 20:00 〜 11/11 09:59");
    expect(html.indexOf("近日開催予定のセールはありません")).toBeLessThan(html.indexOf("次回開催予定"));
  });

  it("keeps the existing empty state when there is no later sale", async () => {
    const html = await renderHome();

    expect(getNextPublishedSaleEvent).toHaveBeenCalledTimes(1);
    expect(html).toContain("近日開催予定のセールはありません");
    expect(html).not.toContain("次回開催予定");
  });

  it("applies the retailer filter to the hint", async () => {
    await renderHome({ retailer: "amazon" });

    expect(getNextPublishedSaleEvent).toHaveBeenCalledWith({ after: IN_14_DAYS, retailerSlug: "amazon" });
  });

  it("hides only the hint when it fails to load", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listPublishedSaleEvents.mockResolvedValue([ACTIVE_SALE]);
    getNextPublishedSaleEvent.mockRejectedValue(new Error("sb_secret_FAKE_SHOULD_NOT_APPEAR"));

    const html = await renderHome();

    expect(html).not.toContain("セール情報を読み込めませんでした");
    expect(html).toContain("開催中セール");
    expect(html).toContain("近日開催予定のセールはありません");
    expect(html).not.toContain("次回開催予定");
    expect(html).not.toContain("sb_secret_");
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("next sale load failed");
    expect(logged).not.toContain("sb_secret_");
  });

  it("puts a sale starting exactly at the 14-day boundary only in the hint", async () => {
    const boundarySale = makeSale(
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      "境界セール",
      IN_14_DAYS.toISOString(),
      "2026-10-25T15:00:00Z",
    );
    // The window query cannot return it (starts_at < boundary); even if it
    // did, the 14-day classification leaves it out of 近日開催.
    listPublishedSaleEvents.mockResolvedValue([boundarySale]);
    getNextPublishedSaleEvent.mockResolvedValue(boundarySale);

    const html = await renderHome();

    expect(html).toContain("近日開催予定のセールはありません");
    expect(html.split("境界セール")).toHaveLength(2);
    expect(html.indexOf("境界セール")).toBeGreaterThan(html.indexOf("次回開催予定"));
  });
});

describe("Home metadata", () => {
  async function homeMetadata(params: Record<string, string | string[] | undefined> = {}) {
    return generateMetadata(homeProps(params));
  }

  const EXPECTED = {
    description: "楽天市場・Amazon・Qoo10の大型セールの開催予定と開催中のセールをまとめて確認できるセールカレンダーです。",
    alternates: { canonical: "/" },
    openGraph: {
      type: "website",
      siteName: "セールカレンダー",
      locale: "ja_JP",
      url: "/",
      title: "セールカレンダー",
      description: "楽天市場・Amazon・Qoo10の大型セールの開催予定と開催中のセールをまとめて確認できるセールカレンダーです。",
      images: [
        {
          url: "/og/sale-calendar-og-v1.png",
          width: 1200,
          height: 630,
          alt: "セールカレンダー：お得なセールを見逃さない",
          type: "image/png",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "セールカレンダー",
      description: "楽天市場・Amazon・Qoo10の大型セールの開催予定と開催中のセールをまとめて確認できるセールカレンダーです。",
      images: [{ url: "/og/sale-calendar-og-v1.png", alt: "セールカレンダー：お得なセールを見逃さない" }],
    },
  };

  it("keeps the Phase 6H metadata (root default title, canonical /) and stays indexable when data loads", async () => {
    listPublishedSaleEvents.mockResolvedValue([ACTIVE_SALE, UPCOMING_SALE]);

    expect(await homeMetadata()).toEqual(EXPECTED);
  });

  it("stays indexable with zero sales", async () => {
    const metadata = await homeMetadata();

    expect(metadata).toEqual(EXPECTED);
    expect(metadata).not.toHaveProperty("robots");
  });

  it.each([
    ["a valid retailer", { retailer: "amazon" }],
    ["an unknown retailer", { retailer: "qoo10" }],
    ["a repeated retailer", { retailer: ["rakuten", "amazon"] }],
  ])("keeps canonical / with %s", async (_label, params) => {
    expect(await homeMetadata(params)).toEqual(EXPECTED);
  });

  it("does not read the next-sale hint, and a failing hint keeps the page indexable", async () => {
    listPublishedSaleEvents.mockResolvedValue([ACTIVE_SALE]);
    getNextPublishedSaleEvent.mockRejectedValue(new Error("hint down"));

    expect(await homeMetadata()).toEqual(EXPECTED);
    expect(getNextPublishedSaleEvent).not.toHaveBeenCalled();

    const html = await renderHome();
    expect(html).toContain("開催中セール");
    expect(html).not.toContain("セール情報を読み込めませんでした");
  });

  it.each([
    ["the retailer read", () => listActiveRetailers.mockRejectedValue(new Error("sb_secret_FAKE retailers"))],
    ["the sale read", () => listPublishedSaleEvents.mockRejectedValue(new Error("sb_secret_FAKE sales"))],
  ])("adds noindex (without nofollow) when %s fails, keeping canonical and OG text without the shared image", async (_label, fail) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fail();

    const metadata = await homeMetadata();

    // Same canonical, title and description; no shared image on the error page.
    expect(metadata).toEqual({
      ...EXPECTED,
      openGraph: { ...EXPECTED.openGraph, images: undefined },
      twitter: { ...EXPECTED.twitter, card: "summary", images: undefined },
      robots: { index: false },
    });
    expect(metadata.openGraph?.images).toBeUndefined();
    expect(metadata.twitter?.images).toBeUndefined();
    expect(metadata.twitter).toMatchObject({ card: "summary" });
    expect(JSON.stringify(metadata)).not.toContain("/og/");
    expect(metadata.robots).not.toHaveProperty("follow");
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("[home] sale load failed: Error");
    expect(logged).not.toContain("sb_secret_");
  });

  it("waits for a request before reading, then reads with the normalized filter", async () => {
    const order: string[] = [];
    connection.mockImplementation(async () => {
      order.push("connection");
    });
    listActiveRetailers.mockImplementation(async () => {
      order.push("retailers");
      return RETAILERS;
    });

    await homeMetadata({ retailer: "amazon" });

    expect(order).toEqual(["connection", "retailers"]);
    expect(listPublishedSaleEvents).toHaveBeenCalledWith(expect.objectContaining({ retailerSlug: "amazon" }));
  });

  it("does not swallow connection() failures", async () => {
    const interrupt = new Error("prerender interrupted");
    connection.mockRejectedValue(interrupt);

    await expect(homeMetadata()).rejects.toBe(interrupt);
    expect(listActiveRetailers).not.toHaveBeenCalled();
  });
});

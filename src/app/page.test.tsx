import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connection, listActiveRetailers, listPublishedSaleEvents } = vi.hoisted(() => ({
  connection: vi.fn(),
  listActiveRetailers: vi.fn(),
  listPublishedSaleEvents: vi.fn(),
}));

vi.mock("next/server", () => ({ connection }));
vi.mock("@/server/data/retailers", () => ({ listActiveRetailers }));
vi.mock("@/server/data/sale-events", () => ({ listPublishedSaleEvents }));

const { default: Home } = await import("./page");

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
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  connection.mockReset();
  listActiveRetailers.mockReset();
  listPublishedSaleEvents.mockReset();
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
  });

  it("does not link to the calendar page yet", async () => {
    listPublishedSaleEvents.mockResolvedValue([ACTIVE_SALE, UPCOMING_SALE]);

    const html = await renderHome();

    expect(html).not.toContain("/calendar");
  });
});

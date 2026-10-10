import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connection, notFound, getPublishedSaleEvent, NOT_FOUND } = vi.hoisted(() => {
  const NOT_FOUND = new Error("NEXT_HTTP_ERROR_FALLBACK;404");
  return {
    connection: vi.fn(),
    notFound: vi.fn(() => {
      throw NOT_FOUND;
    }),
    getPublishedSaleEvent: vi.fn(),
    NOT_FOUND,
  };
});

vi.mock("next/server", () => ({ connection }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/server/data/sale-events", () => ({ getPublishedSaleEvent }));

const { default: SaleDetailPage } = await import("./page");

// Fake values only; none of these are real credentials or hosts.
const SALE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const SALE = {
  id: SALE_ID,
  title: "スーパーSALE",
  description: "最大50%OFF",
  startsAt: "2026-11-04T11:00:00Z",
  endsAt: "2026-11-10T17:00:00Z",
  isDateOnly: false,
  sourceUrl: "https://www.rakuten.co.jp/event/supersale/",
  sourceCheckedAt: "2026-10-31T15:30:00Z",
  publishedAt: "2026-10-20T00:00:00Z",
  retailer: { slug: "rakuten", name: "楽天市場" },
};

function props(saleId = SALE_ID) {
  return { params: Promise.resolve({ saleId }), searchParams: Promise.resolve({}) };
}

async function renderDetail(saleId = SALE_ID) {
  return renderToStaticMarkup(await SaleDetailPage(props(saleId)));
}

beforeEach(() => {
  connection.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  connection.mockReset();
  getPublishedSaleEvent.mockReset();
  notFound.mockClear();
});

describe("SaleDetailPage", () => {
  it("waits for a request, then reads the sale for the awaited param", async () => {
    const order: string[] = [];
    connection.mockImplementation(async () => {
      order.push("connection");
    });
    getPublishedSaleEvent.mockImplementation(async (id: string) => {
      order.push(`get:${id}`);
      return SALE;
    });

    await renderDetail();

    expect(order).toEqual(["connection", `get:${SALE_ID}`]);
  });

  it("renders the sale", async () => {
    getPublishedSaleEvent.mockResolvedValue(SALE);

    const html = await renderDetail();

    expect(html).toContain("スーパーSALE");
    expect(html).toContain("楽天市場");
    expect(html).toContain("11/4 20:00 〜 11/11 02:00");
    expect(html).toContain("最大50%OFF");
    expect(html).toContain('href="/"');
  });

  it("links to the official source safely", async () => {
    getPublishedSaleEvent.mockResolvedValue(SALE);

    const html = await renderDetail();

    expect(html).toContain(`href="${SALE.sourceUrl}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("shows the checked date only when present", async () => {
    getPublishedSaleEvent.mockResolvedValue(SALE);
    expect(await renderDetail()).toContain("2026/11/1 時点の情報");

    getPublishedSaleEvent.mockResolvedValue({ ...SALE, sourceCheckedAt: null });
    expect(await renderDetail()).not.toContain("時点の情報");
  });

  it("omits the description when null", async () => {
    getPublishedSaleEvent.mockResolvedValue({ ...SALE, description: null });

    const html = await renderDetail();

    expect(html).not.toContain("最大50%OFF");
    expect(html).toContain("スーパーSALE");
  });

  it("calls notFound() for a missing sale and lets it propagate", async () => {
    getPublishedSaleEvent.mockResolvedValue(null);

    await expect(SaleDetailPage(props("not-a-uuid"))).rejects.toBe(NOT_FOUND);
    expect(notFound).toHaveBeenCalledTimes(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("renders a generic error (not 404) when loading fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    getPublishedSaleEvent.mockRejectedValue(
      new Error("sb_publishable_FAKE_SHOULD_NOT_APPEAR permission denied"),
    );

    const html = await renderDetail();

    expect(html).toContain("セール情報を読み込めませんでした");
    expect(html).not.toContain("sb_publishable_");
    expect(html).not.toContain("permission denied");
    expect(notFound).not.toHaveBeenCalled();
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("sb_publishable_");
  });

  it("does not swallow connection() failures", async () => {
    const interrupt = new Error("prerender interrupted");
    connection.mockRejectedValue(interrupt);

    await expect(SaleDetailPage(props())).rejects.toBe(interrupt);
    expect(getPublishedSaleEvent).not.toHaveBeenCalled();
  });
});

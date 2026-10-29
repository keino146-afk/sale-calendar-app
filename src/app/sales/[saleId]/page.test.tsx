import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connection, notFound, getPublishedSaleEvent, NOT_FOUND, isProductionDeployment, productionSaleUrl } =
  vi.hoisted(() => {
    const NOT_FOUND = new Error("NEXT_HTTP_ERROR_FALLBACK;404");
    return {
      connection: vi.fn(),
      notFound: vi.fn(() => {
        throw NOT_FOUND;
      }),
      getPublishedSaleEvent: vi.fn(),
      NOT_FOUND,
      isProductionDeployment: vi.fn(),
      productionSaleUrl: vi.fn(),
    };
  });

vi.mock("next/server", () => ({ connection }));
vi.mock("next/navigation", () => ({ notFound }));
vi.mock("@/server/data/sale-events", () => ({ getPublishedSaleEvent }));
// The deployment check is tested in src/server/share-url.test.ts; here it is
// switched between Production and not.
vi.mock("@/server/share-url", () => ({ isProductionDeployment, productionSaleUrl }));
// Stand-in that shows what the page passes (the real component renders no
// button on the server).
vi.mock("@/components/ShareActions", async () => {
  const { createElement } = await import("react");
  return {
    ShareActions: ({ shareUrl, title }: { shareUrl: string | null; title: string }) =>
      createElement("div", { "data-share-actions": shareUrl ?? "none", "data-share-title": title }),
  };
});

const { default: SaleDetailPage, generateMetadata } = await import("./page");

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

const PRODUCTION_SALE_URL = `https://sale-calendar-app.vercel.app/sales/${SALE_ID}`;

// Production by default; tests for other deployments switch it off.
function setProduction(production: boolean) {
  isProductionDeployment.mockReturnValue(production);
  productionSaleUrl.mockImplementation((id: string) =>
    production ? `https://sale-calendar-app.vercel.app/sales/${id}` : null,
  );
}

beforeEach(() => {
  setProduction(true);
  connection.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  connection.mockReset();
  getPublishedSaleEvent.mockReset();
  notFound.mockClear();
  isProductionDeployment.mockReset();
  productionSaleUrl.mockReset();
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
    // Exclusive end 11/11 02:00 is shown as the last running minute.
    expect(html).toContain("11/4 20:00 〜 11/11 01:59");
    expect(html).not.toContain("11/11 02:00");
    expect(html).toContain("最大50%OFF");
    expect(html).toContain('href="/"');
    expect(html).toMatch(/<\/main><footer[^>]*>.*運営：セールカレンダー運営.*<\/footer>$/);
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
    expect(html).toMatch(/<\/main><footer[^>]*>.*運営：セールカレンダー運営.*<\/footer>$/);
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

describe("SaleDetailPage timing state", () => {
  // SALE runs 2026-11-04T11:00Z to 2026-11-10T17:00Z (exclusive end).
  async function renderAt(now: string, sale: typeof SALE = SALE) {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    getPublishedSaleEvent.mockResolvedValue(sale);
    try {
      return await renderDetail();
    } finally {
      vi.useRealTimers();
    }
  }

  it("shows 開催予定 before the start, without the ended notice", async () => {
    const html = await renderAt("2026-11-04T10:59:59Z");

    expect(html).toContain('data-timing="upcoming"');
    expect(html).toContain("開催予定");
    expect(html).not.toContain("このセールは終了しました");
    expect(html).not.toContain("更新されている場合があります");
  });

  it("shows 開催中 from the exact start", async () => {
    const html = await renderAt("2026-11-04T11:00:00Z");

    expect(html).toContain('data-timing="active"');
    expect(html).toContain("開催中");
    expect(html).not.toContain("このセールは終了しました");
  });

  it("shows 終了しました from the exact stored end, keeping the period, link and checked date", async () => {
    const html = await renderAt("2026-11-10T17:00:00Z");

    expect(html).toContain('data-timing="ended"');
    expect(html).toContain("終了しました");
    expect(html).toContain("このセールは終了しました");
    // The public period still shows the last running minute.
    expect(html).toContain("11/4 20:00 〜 11/11 01:59");
    expect(html).toContain("最大50%OFF");
    expect(html).toContain(`href="${SALE.sourceUrl}"`);
    expect(html).toContain("公式ページを見る");
    expect(html).toContain("公式ページの内容は更新されている場合があります");
    expect(html).toContain("2026/11/1 時点の情報");
  });

  it("is still 開催中 one millisecond before the stored end", async () => {
    const html = await renderAt("2026-11-10T16:59:59.999Z");

    expect(html).toContain('data-timing="active"');
    expect(html).not.toContain("このセールは終了しました");
  });

  it("ends a date-only sale at the next day's midnight JST", async () => {
    // 2026-11-11 only: 11/11 00:00 JST to 11/12 00:00 JST.
    const oneDay = { ...SALE, isDateOnly: true, startsAt: "2026-11-10T15:00:00Z", endsAt: "2026-11-11T15:00:00Z" };

    expect(await renderAt("2026-11-11T14:59:59.999Z", oneDay)).toContain('data-timing="active"');
    expect(await renderAt("2026-11-11T15:00:00Z", oneDay)).toContain('data-timing="ended"');
  });

  it("never shows the internal workflow status", async () => {
    for (const now of ["2026-11-01T00:00:00Z", "2026-11-05T00:00:00Z", "2026-12-01T00:00:00Z"]) {
      const html = await renderAt(now);
      expect(html).not.toMatch(/published|公開中/);
    }
  });
});

describe("SaleDetailPage metadata", () => {
  it("titles the page {title}（{retailer}） with the public period and a canonical URL", async () => {
    getPublishedSaleEvent.mockResolvedValue(SALE);

    const metadata = await generateMetadata(props());

    expect(connection).toHaveBeenCalled();
    expect(getPublishedSaleEvent).toHaveBeenCalledWith(SALE_ID);
    expect(metadata.title).toBe("スーパーSALE（楽天市場）");
    // The public period (last running minute), not the stored exclusive end.
    expect(metadata.description).toBe(
      "楽天市場「スーパーSALE」の開催期間は11/4 20:00 〜 11/11 01:59です。開催情報と公式ページへのリンクを確認できます。",
    );
    expect(metadata.alternates).toEqual({ canonical: `/sales/${SALE_ID}` });
    expect(metadata.openGraph).toMatchObject({
      url: `/sales/${SALE_ID}`,
      title: "スーパーSALE（楽天市場） | セールカレンダー",
      description: metadata.description,
      type: "website",
    });
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: "スーパーSALE（楽天市場） | セールカレンダー",
    });
    expect(metadata).not.toHaveProperty("robots");
  });

  it("never puts the current timing state in the description", async () => {
    getPublishedSaleEvent.mockResolvedValue(SALE);
    for (const now of ["2026-11-01T00:00:00Z", "2026-11-05T00:00:00Z", "2026-12-01T00:00:00Z"]) {
      vi.useFakeTimers();
      vi.setSystemTime(new Date(now));
      try {
        const { description } = await generateMetadata(props());
        expect(description).not.toMatch(/開催予定|開催中|終了しました/);
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("passes markup-like titles through unchanged for Next.js to escape", async () => {
    getPublishedSaleEvent.mockResolvedValue({ ...SALE, title: `<script>alert("x")</script> & 'A' <b>` });

    const metadata = await generateMetadata(props());

    expect(metadata.title).toBe(`<script>alert("x")</script> & 'A' <b>（楽天市場）`);
  });

  it("adds the shared image, never a sale-specific one", async () => {
    getPublishedSaleEvent.mockResolvedValue(SALE);

    const metadata = await generateMetadata(props());

    expect(metadata.openGraph).toMatchObject({
      images: [{ url: "/og/sale-calendar-og-v1.png", width: 1200, height: 630, type: "image/png" }],
    });
    expect(metadata.twitter).toMatchObject({ images: [{ url: "/og/sale-calendar-og-v1.png" }] });
    expect(JSON.stringify([metadata.openGraph?.images, metadata.twitter?.images])).not.toMatch(
      /スーパーSALE|楽天|cccccccc/,
    );
  });

  it("off Production, names no Production canonical URL or og:url for the sale and stays out of the index", async () => {
    setProduction(false);
    getPublishedSaleEvent.mockResolvedValue(SALE);

    const metadata = await generateMetadata(props());

    expect(metadata).not.toHaveProperty("alternates");
    expect(metadata.openGraph).not.toHaveProperty("url");
    expect(JSON.stringify(metadata)).not.toContain(SALE_ID);
    expect(metadata.robots).toEqual({ index: false });
    // Title, description and the shared image are unchanged.
    expect(metadata.title).toBe("スーパーSALE（楽天市場）");
    expect(metadata.openGraph).toMatchObject({ images: [{ url: "/og/sale-calendar-og-v1.png" }] });
  });

  it("adds nothing for a missing sale, leaving the page's 404 (with noindex) in charge", async () => {
    getPublishedSaleEvent.mockResolvedValue(null);

    expect(await generateMetadata(props("not-a-uuid"))).toEqual({});
  });

  it("keeps a load failure page out of the index without leaking details", async () => {
    getPublishedSaleEvent.mockRejectedValue(new Error("sb_secret_FAKE_SHOULD_NOT_APPEAR"));

    // No image, canonical URL or og:url either.
    expect(await generateMetadata(props())).toEqual({ robots: { index: false } });
  });
});

describe("SaleDetailPage sharing", () => {
  it("passes the Production sale URL for the loaded sale and its title on Production", async () => {
    getPublishedSaleEvent.mockResolvedValue(SALE);

    const html = await renderDetail();

    expect(productionSaleUrl).toHaveBeenCalledWith(SALE_ID);
    expect(html).toContain(`data-share-actions="${PRODUCTION_SALE_URL}"`);
    expect(html).toContain('data-share-title="スーパーSALE（楽天市場）"');
    // Near the title and period, before the official page link.
    expect(html.indexOf("data-share-actions")).toBeGreaterThan(html.indexOf("11/4 20:00 〜 11/11 01:59"));
    expect(html.indexOf("data-share-actions")).toBeLessThan(html.indexOf("公式ページを見る"));
  });

  it("passes no URL off Production, so no share or copy button can appear", async () => {
    setProduction(false);
    getPublishedSaleEvent.mockResolvedValue(SALE);

    const html = await renderDetail();

    expect(html).toContain('data-share-actions="none"');
    expect(html).not.toContain(PRODUCTION_SALE_URL);
  });

  it.each([
    ["upcoming", "2026-11-01T00:00:00Z"],
    ["active", "2026-11-05T00:00:00Z"],
    ["ended", "2026-12-01T00:00:00Z"],
  ])("offers sharing for a published %s sale", async (_label, now) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(now));
    getPublishedSaleEvent.mockResolvedValue(SALE);
    try {
      expect(await renderDetail()).toContain(`data-share-actions="${PRODUCTION_SALE_URL}"`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers no sharing for a missing or unpublished sale (404)", async () => {
    getPublishedSaleEvent.mockResolvedValue(null);

    await expect(SaleDetailPage(props("not-a-uuid"))).rejects.toBe(NOT_FOUND);
    expect(productionSaleUrl).not.toHaveBeenCalled();
  });

  it("offers no sharing when the sale cannot be loaded", async () => {
    getPublishedSaleEvent.mockRejectedValue(new Error("load failed"));

    const html = await renderDetail();

    expect(html).toContain("セール情報を読み込めませんでした");
    expect(html).not.toContain("data-share-actions");
    expect(productionSaleUrl).not.toHaveBeenCalled();
  });
});

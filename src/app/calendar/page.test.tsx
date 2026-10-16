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

const { default: CalendarPage, metadata: calendarMetadata } = await import("./page");

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

const NOW = new Date("2026-10-10T03:00:00.000Z"); // 2026-10-10 12:00 JST

function makeSale(id: string, title: string, startsAt: string, endsAt: string, isDateOnly = false) {
  return {
    id,
    title,
    description: null,
    startsAt,
    endsAt,
    isDateOnly,
    sourceUrl: "https://www.rakuten.co.jp/event/",
    sourceCheckedAt: null,
    publishedAt: "2026-10-01T00:00:00Z",
    retailer: { slug: "rakuten", name: "楽天市場" },
  };
}

const OCTOBER_SALE = makeSale(
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "十月セール",
  "2026-10-14T15:00:00Z", // 2026-10-15 JST
  "2026-10-16T15:00:00Z", // exclusive 2026-10-17 JST
  true,
);
// Only on 2026-09-28 JST: inside the grid, outside October.
const SEPTEMBER_GRID_SALE = makeSale(
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "九月末セール",
  "2026-09-27T15:00:00Z",
  "2026-09-28T15:00:00Z",
  true,
);

type Params = Record<string, string | string[] | undefined>;

function calendarProps(params: Params = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(params) };
}

async function renderCalendar(params: Params = {}) {
  return renderToStaticMarkup(await CalendarPage(calendarProps(params)));
}

// The <a> element for one day cell.
function cellHtml(html: string, dateKey: string): string {
  const marker = html.indexOf(`data-date="${dateKey}"`);
  expect(marker).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf("<a", marker), html.indexOf("</a>", marker));
}

type Segment = { id: string; startColumn: number; span: number; lane: number };

function segments(html: string): Segment[] {
  return [
    ...html.matchAll(
      /data-sale-id="([^"]+)" data-start-column="(\d)" data-span="(\d)" data-lane="(\d)"/g,
    ),
  ].map(([, id, startColumn, span, lane]) => ({
    id,
    startColumn: Number(startColumn),
    span: Number(span),
    lane: Number(lane),
  }));
}

function selectedSection(html: string): string {
  const start = html.indexOf('id="selected-day-heading"');
  return html.slice(start, html.indexOf('id="month-sales-heading"'));
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

describe("CalendarPage", () => {
  it("waits for a request, then reads retailers and events once each", async () => {
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
      return [OCTOBER_SALE, SEPTEMBER_GRID_SALE];
    });

    await renderCalendar();

    expect(order).toEqual(["connection", "retailers", "events"]);
    expect(listActiveRetailers).toHaveBeenCalledTimes(1);
    expect(listPublishedSaleEvents).toHaveBeenCalledTimes(1);
  });

  it("does not swallow connection() failures", async () => {
    const interrupt = new Error("prerender interrupted");
    connection.mockRejectedValue(interrupt);

    await expect(CalendarPage(calendarProps())).rejects.toBe(interrupt);
    expect(listActiveRetailers).not.toHaveBeenCalled();
    expect(listPublishedSaleEvents).not.toHaveBeenCalled();
  });

  it("queries the 42-day grid window of the current JST month by default", async () => {
    const html = await renderCalendar();

    expect(html).toContain("2026年10月");
    expect(listPublishedSaleEvents).toHaveBeenCalledWith({
      from: new Date("2026-09-26T15:00:00.000Z"),
      to: new Date("2026-11-07T15:00:00.000Z"),
      retailerSlug: undefined,
    });
  });

  it("uses the requested month", async () => {
    const html = await renderCalendar({ year: "2027", month: "1" });

    expect(html).toContain("2027年1月");
    expect(listPublishedSaleEvents).toHaveBeenCalledWith(
      expect.objectContaining({ from: new Date("2026-12-26T15:00:00.000Z") }),
    );
  });

  it.each([
    ["invalid year", { year: "1999", month: "5" }],
    ["invalid month", { year: "2027", month: "13" }],
    ["repeated year", { year: ["2027", "2028"], month: "5" }],
  ])("falls back to the current month for an %s", async (_label, params) => {
    const html = await renderCalendar(params);

    expect(html).toContain("2026年10月");
  });

  it("passes a known retailer filter to the event query", async () => {
    await renderCalendar({ retailer: "amazon" });

    expect(listPublishedSaleEvents).toHaveBeenCalledWith(
      expect.objectContaining({ retailerSlug: "amazon" }),
    );
  });

  it.each([
    ["unknown slug", { retailer: "qoo10" }],
    ["malformed value", { retailer: "Rakuten,Amazon" }],
    ["repeated parameter", { retailer: ["rakuten", "amazon"] }],
  ])("falls back to all retailers for an %s", async (_label, params) => {
    await renderCalendar(params);

    expect(listPublishedSaleEvents).toHaveBeenCalledWith(
      expect.objectContaining({ retailerSlug: undefined }),
    );
  });

  it("renders the app header with back and today links", async () => {
    const html = await renderCalendar({ retailer: "amazon" });

    expect(html).toContain(">カレンダー</h1>");
    expect(html).toContain('aria-label="ホームへ戻る"');
    expect(html).toContain('href="/"');
    expect(html).toContain('aria-label="今日を表示"');
    expect(html).toContain('href="/calendar?retailer=amazon"');
  });

  it("renders weekday headers and a 42-day grid with month and today markers", async () => {
    const html = await renderCalendar();

    expect(html.indexOf(">日<")).toBeLessThan(html.indexOf(">土<"));
    for (const label of ["日", "月", "火", "水", "木", "金", "土"]) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html.match(/data-date="/g)).toHaveLength(42);
    expect(html).toContain('data-date="2026-09-27" data-in-month="false"');
    expect(html).toContain('data-date="2026-10-01" data-in-month="true"');
    expect(html).toContain('data-date="2026-11-07" data-in-month="false"');
    expect(html.match(/aria-current="date"/g)).toHaveLength(1);
    expect(cellHtml(html, "2026-10-10")).toContain('aria-current="date"');
    expect(cellHtml(html, "2026-10-10")).toContain("今日");
  });

  it("renders six week rows of seven days and marks only the selected day", async () => {
    const html = await renderCalendar({ year: "2026", month: "10", day: "2026-10-21" });

    const weekStarts = [...html.matchAll(/data-week-start="([^"]+)"/g)].map(([, key]) => key);
    expect(weekStarts).toEqual([
      "2026-09-27",
      "2026-10-04",
      "2026-10-11",
      "2026-10-18",
      "2026-10-25",
      "2026-11-01",
    ]);
    expect(html.match(/data-selected="true"/g)).toHaveLength(1);
    expect(cellHtml(html, "2026-10-21")).toContain("選択中");
    // Today stays marked separately from the selection.
    expect(cellHtml(html, "2026-10-10")).toContain('aria-current="date"');
    expect(cellHtml(html, "2026-10-10")).not.toContain("選択中");
  });

  it("links month navigation with labels, keeping the selected retailer", async () => {
    const all = await renderCalendar({ year: "2026", month: "1" });
    expect(all).toContain('aria-label="前の月"');
    expect(all).toContain('aria-label="次の月"');
    expect(all).toContain('href="/calendar?year=2025&amp;month=12"');
    expect(all).toContain('href="/calendar?year=2026&amp;month=2"');

    const filtered = await renderCalendar({ year: "2026", month: "12", retailer: "amazon" });
    expect(filtered).toContain('href="/calendar?year=2026&amp;month=11&amp;retailer=amazon"');
    expect(filtered).toContain('href="/calendar?year=2027&amp;month=1&amp;retailer=amazon"');
    expect(filtered).toContain('href="/calendar?retailer=amazon"');
  });

  it("keeps the month and selected day in retailer filter links", async () => {
    const html = await renderCalendar({ year: "2026", month: "11", day: "2026-11-20" });

    expect(html).toContain('href="/calendar?year=2026&amp;month=11&amp;day=2026-11-20"');
    expect(html).toContain(
      'href="/calendar?year=2026&amp;month=11&amp;day=2026-11-20&amp;retailer=rakuten"',
    );
    expect(html).toContain(
      'href="/calendar?year=2026&amp;month=11&amp;day=2026-11-20&amp;retailer=amazon"',
    );
  });

  it("links each day to itself, keeping year, month and retailer", async () => {
    const html = await renderCalendar({ year: "2026", month: "10", retailer: "amazon" });

    expect(cellHtml(html, "2026-10-15")).toContain(
      'href="/calendar?year=2026&amp;month=10&amp;day=2026-10-15&amp;retailer=amazon"',
    );
    // Outside-month days stay on the displayed month.
    expect(cellHtml(html, "2026-09-27")).toContain(
      'href="/calendar?year=2026&amp;month=10&amp;day=2026-09-27&amp;retailer=amazon"',
    );
  });

  it("selects a valid requested day", async () => {
    const html = await renderCalendar({ year: "2026", month: "10", day: "2026-10-15" });

    expect(cellHtml(html, "2026-10-15")).toContain('data-selected="true"');
    expect(cellHtml(html, "2026-10-10")).toContain('data-selected="false"');
    expect(html.match(/data-selected="true"/g)).toHaveLength(1);
    expect(selectedSection(html)).toContain("10月15日(木)");
  });

  it.each([
    ["malformed", "2026-10-5"],
    ["outside the grid", "2026-12-01"],
    ["not a date", "today"],
    ["repeated", ["2026-10-15", "2026-10-16"]],
  ])("falls back to today for a %s day when today is in the grid", async (_label, day) => {
    const html = await renderCalendar({ year: "2026", month: "10", day });

    expect(cellHtml(html, "2026-10-10")).toContain('data-selected="true"');
    expect(selectedSection(html)).toContain("10月10日(土)");
  });

  it("defaults to the 1st of the month when today is outside the grid", async () => {
    const html = await renderCalendar({ year: "2026", month: "12" });

    expect(cellHtml(html, "2026-12-01")).toContain('data-selected="true"');
    expect(selectedSection(html)).toContain("12月1日(火)");
  });

  it("lists the selected day's sales with detail links", async () => {
    listPublishedSaleEvents.mockResolvedValue([OCTOBER_SALE, SEPTEMBER_GRID_SALE]);

    const html = await renderCalendar({ year: "2026", month: "10", day: "2026-10-16" });
    const section = selectedSection(html);

    expect(section).toContain("1件のセール");
    expect(section).toContain("十月セール");
    expect(section).toContain(`href="/sales/${OCTOBER_SALE.id}"`);
    expect(section).toContain("楽天市場");
    expect(section).toContain("10/15(木) 〜 10/16(金)");
    expect(section).not.toContain("九月末セール");
  });

  it("shows an empty selected day", async () => {
    listPublishedSaleEvents.mockResolvedValue([OCTOBER_SALE]);

    // The exclusive end (2026-10-17 00:00 JST) is not part of the sale.
    const html = await renderCalendar({ year: "2026", month: "10", day: "2026-10-17" });
    const section = selectedSection(html);

    expect(section).toContain("0件のセール");
    expect(section).toContain("この日のセールはありません");
    expect(section).not.toContain("/sales/");
  });

  it("shows a timed sale's last running minute but keeps its days unchanged", async () => {
    // 2026-10-13 00:00 JST to 2026-10-16 00:00 JST (exclusive)
    const timed = makeSale("cccccccc-cccc-4ccc-8ccc-cccccccccccc", "先行セール", "2026-10-12T15:00:00Z", "2026-10-15T15:00:00Z");
    listPublishedSaleEvents.mockResolvedValue([timed]);

    const lastDay = await renderCalendar({ year: "2026", month: "10", day: "2026-10-15" });
    // Bar on 10/13 (Tue) to 10/15 (Thu) only, as before.
    expect(segments(lastDay)).toEqual([{ id: timed.id, startColumn: 2, span: 3, lane: 0 }]);
    expect(selectedSection(lastDay)).toContain("10/13 00:00 〜 10/15 23:59");
    expect(lastDay).not.toContain("10/16 00:00");

    // The exclusive end day is still not part of the sale.
    const endDay = await renderCalendar({ year: "2026", month: "10", day: "2026-10-16" });
    expect(selectedSection(endDay)).toContain("0件のセール");
  });

  it("draws sale bars per week and lists only this month's sales", async () => {
    listPublishedSaleEvents.mockResolvedValue([OCTOBER_SALE, SEPTEMBER_GRID_SALE]);

    const html = await renderCalendar();

    expect(segments(html)).toEqual([
      // 2026-09-28 (Mon) in the first week row.
      { id: SEPTEMBER_GRID_SALE.id, startColumn: 1, span: 1, lane: 0 },
      // 2026-10-15 (Thu) to 2026-10-16 (Fri).
      { id: OCTOBER_SALE.id, startColumn: 4, span: 2, lane: 0 },
    ]);
    expect(cellHtml(html, "2026-10-15")).toContain("セール1件");
    expect(cellHtml(html, "2026-10-17")).toContain("セールなし");

    const list = html.slice(html.indexOf('id="month-sales-heading"'));
    expect(list).toContain("十月セール");
    expect(list).not.toContain("九月末セール");
  });

  it("splits a sale crossing a week boundary into two bars", async () => {
    // 2026-10-16 (Fri) to 2026-10-20 (Tue), date-only.
    const crossing = makeSale(
      "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      "週またぎセール",
      "2026-10-15T15:00:00Z",
      "2026-10-20T15:00:00Z",
      true,
    );
    listPublishedSaleEvents.mockResolvedValue([crossing]);

    const html = await renderCalendar();

    expect(segments(html)).toEqual([
      { id: crossing.id, startColumn: 5, span: 2, lane: 0 },
      { id: crossing.id, startColumn: 0, span: 3, lane: 0 },
    ]);
  });

  it("shows at most two bar lanes and a +n counter", async () => {
    listPublishedSaleEvents.mockResolvedValue(
      ["1", "2", "3", "4"].map((n) =>
        makeSale(
          `0000000${n}-0000-4000-8000-000000000000`,
          `セール${n}`,
          "2026-10-19T15:00:00Z",
          "2026-10-20T15:00:00Z",
          true,
        ),
      ),
    );

    const html = await renderCalendar();
    const bars = segments(html);

    expect(bars).toHaveLength(2);
    expect(bars.map((bar) => bar.lane)).toEqual([0, 1]);
    expect(html).toContain('data-more-date="2026-10-20"');
    expect(html.slice(html.indexOf('data-more-date="2026-10-20"'))).toMatch(/^[^<]*>\+2</);
    expect(cellHtml(html, "2026-10-20")).toContain("セール4件");
  });

  it("renders the empty state", async () => {
    const html = await renderCalendar();

    expect(html).toContain("この月のセールはありません");
    expect(html).toContain("この日のセールはありません");
    expect(html).not.toContain('href="/sales/');
    expect(segments(html)).toEqual([]);
  });

  it("is a Server Component without client directives", async () => {
    const { readFile } = await import("node:fs/promises");
    for (const file of [
      "src/app/calendar/page.tsx",
      "src/components/MonthGrid.tsx",
      "src/components/RetailerFilter.tsx",
      "src/components/SaleList.tsx",
    ]) {
      expect(await readFile(file, "utf8")).not.toMatch(/["']use client["']/);
    }
  });

  it("renders a generic error without leaking details and logs only the error name", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listPublishedSaleEvents.mockRejectedValue(
      new Error("sb_secret_FAKE_SHOULD_NOT_APPEAR https://abcdefghijklmnopqrst.supabase.co"),
    );

    const html = await renderCalendar();

    expect(html).toContain("セール情報を読み込めませんでした");
    expect(html).not.toContain("sb_secret_");
    expect(html).not.toContain("supabase.co");
    expect(html).not.toContain('data-date="');
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("sb_secret_");
    expect(logged).not.toContain("supabase.co");
  });

  it("renders a generic error when retailers fail to load", async () => {
    listActiveRetailers.mockRejectedValue(new Error("upstream detail"));

    const html = await renderCalendar();

    expect(html).toContain("セール情報を読み込めませんでした");
    expect(html).not.toContain("upstream detail");
    expect(listPublishedSaleEvents).not.toHaveBeenCalled();
  });
});

describe("Calendar metadata", () => {
  it("is titled カレンダー with one canonical URL for every month and day view", () => {
    // Static metadata: ?year=&month=&day= cannot change it.
    expect(calendarMetadata.title).toBe("カレンダー");
    expect(calendarMetadata.description).toContain("カレンダー");
    expect(calendarMetadata.alternates).toEqual({ canonical: "/calendar" });
    expect(calendarMetadata.openGraph).toMatchObject({ url: "/calendar", title: "カレンダー | セールカレンダー" });
    expect(calendarMetadata.twitter).toMatchObject({ card: "summary", title: "カレンダー | セールカレンダー" });
  });
});

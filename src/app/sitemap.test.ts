import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connection, listSitemapSaleEvents } = vi.hoisted(() => ({
  connection: vi.fn(),
  listSitemapSaleEvents: vi.fn(),
}));

vi.mock("next/server", () => ({ connection }));
vi.mock("@/server/data/sale-events", () => ({ listSitemapSaleEvents }));

const { default: sitemap } = await import("./sitemap");

const NOW = new Date("2026-10-16T03:00:00.000Z");
const STATIC_ENTRIES = [
  { url: "https://sale-calendar-app.vercel.app/" },
  { url: "https://sale-calendar-app.vercel.app/calendar" },
];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  connection.mockResolvedValue(undefined);
  listSitemapSaleEvents.mockResolvedValue([]);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  connection.mockReset();
  listSitemapSaleEvents.mockReset();
});

describe("sitemap", () => {
  it("waits for a request before reading sales, so a build never reads Supabase", async () => {
    const order: string[] = [];
    connection.mockImplementation(async () => {
      order.push("connection");
    });
    listSitemapSaleEvents.mockImplementation(async () => {
      order.push("sales");
      return [];
    });

    await sitemap();

    expect(order).toEqual(["connection", "sales"]);
  });

  it("does not swallow connection() failures", async () => {
    const interrupt = new Error("prerender interrupted");
    connection.mockRejectedValue(interrupt);

    await expect(sitemap()).rejects.toBe(interrupt);
    expect(listSitemapSaleEvents).not.toHaveBeenCalled();
  });

  it("lists home, calendar and the not-yet-ended published sales, in the returned order", async () => {
    listSitemapSaleEvents.mockResolvedValue([
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", updatedAt: "2026-10-10T00:00:00.000000+00:00" },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", updatedAt: "2026-10-12T00:00:00.000000+00:00" },
    ]);

    expect(await sitemap()).toEqual([
      ...STATIC_ENTRIES,
      {
        url: "https://sale-calendar-app.vercel.app/sales/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        lastModified: "2026-10-10T00:00:00.000000+00:00",
      },
      {
        url: "https://sale-calendar-app.vercel.app/sales/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        lastModified: "2026-10-12T00:00:00.000000+00:00",
      },
    ]);
    expect(listSitemapSaleEvents).toHaveBeenCalledWith({ now: NOW });
  });

  it("falls back to home and calendar when sales cannot be read, logging only the error name", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listSitemapSaleEvents.mockRejectedValue(new Error("sb_secret_FAKE https://abcdefghijklmnopqrst.supabase.co"));

    expect(await sitemap()).toEqual(STATIC_ENTRIES);
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("[sitemap] sale load failed: Error");
    expect(logged).not.toContain("sb_secret_");
    expect(logged).not.toContain("supabase.co");
  });

  it("only ever uses the Production origin", async () => {
    listSitemapSaleEvents.mockResolvedValue([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", updatedAt: "2026-10-10T00:00:00Z" }]);

    for (const entry of await sitemap()) {
      expect(entry.url.startsWith("https://sale-calendar-app.vercel.app/")).toBe(true);
    }
  });
});

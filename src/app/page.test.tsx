import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { connection, listActiveRetailers } = vi.hoisted(() => ({
  connection: vi.fn(),
  listActiveRetailers: vi.fn(),
}));

vi.mock("next/server", () => ({ connection }));
vi.mock("@/server/data/retailers", () => ({ listActiveRetailers }));

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

async function renderHome() {
  return renderToStaticMarkup(await Home());
}

beforeEach(() => {
  connection.mockResolvedValue(undefined);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  connection.mockReset();
  listActiveRetailers.mockReset();
});

describe("Home", () => {
  it("waits for a request before reading retailers", async () => {
    const order: string[] = [];
    connection.mockImplementation(async () => {
      order.push("connection");
    });
    listActiveRetailers.mockImplementation(async () => {
      order.push("listActiveRetailers");
      return RETAILERS;
    });

    await renderHome();

    expect(order).toEqual(["connection", "listActiveRetailers"]);
  });

  it("renders retailer names only", async () => {
    listActiveRetailers.mockResolvedValue(RETAILERS);

    const html = await renderHome();

    expect(html).toContain("セールカレンダー");
    expect(html).toContain("接続確認");
    expect(html).toContain("利用可能なショップ");
    expect(html).toContain("楽天市場");
    expect(html).toContain("Amazon");
    for (const retailer of RETAILERS) {
      expect(html).not.toContain(retailer.id);
      expect(html).not.toContain(retailer.officialBaseUrl);
    }
  });

  it("renders a generic message when there are no retailers", async () => {
    listActiveRetailers.mockResolvedValue([]);

    const html = await renderHome();

    expect(html).toContain("現在利用可能なショップはありません");
    expect(html).not.toContain("ショップ情報を読み込めませんでした");
  });

  it("renders a generic error without leaking error details", async () => {
    const detail =
      "sb_publishable_FAKE_SHOULD_NOT_APPEAR https://abcdefghijklmnopqrst.supabase.co permission denied";
    listActiveRetailers.mockRejectedValue(new Error(detail));

    const html = await renderHome();

    expect(html).toContain("ショップ情報を読み込めませんでした");
    expect(html).not.toContain("sb_publishable_");
    expect(html).not.toContain("supabase.co");
    expect(html).not.toContain("permission denied");
    expect(html).not.toContain("楽天市場");
  });

  it("logs only the error name, never the message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    listActiveRetailers.mockRejectedValue(new Error("sb_secret_FAKE_SHOULD_NOT_BE_LOGGED"));

    await renderHome();

    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain("Error");
    expect(logged).not.toContain("sb_secret_FAKE_SHOULD_NOT_BE_LOGGED");
  });

  it("does not swallow connection() failures", async () => {
    const interrupt = new Error("prerender interrupted");
    connection.mockRejectedValue(interrupt);
    listActiveRetailers.mockResolvedValue(RETAILERS);

    await expect(Home()).rejects.toBe(interrupt);
    expect(listActiveRetailers).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import type { AdminSupabaseClient } from "@/server/supabase/admin-client";
import { checkSaleSourceUrl } from "./admin-source-policy";

const AMAZON = { id: "22222222-2222-4222-8222-222222222222", officialBaseUrl: "https://www.amazon.co.jp/" };
const ARTICLE = "https://www.aboutamazon.jp/news/amazon-prime/prime-appreciation-sale-2026";

function client(result: unknown) {
  const rpc = vi.fn(() => (result instanceof Error ? Promise.reject(result) : Promise.resolve(result)));
  return { supabase: { rpc } as unknown as AdminSupabaseClient, rpc };
}

describe("checkSaleSourceUrl", () => {
  it("allows the retailer's official domain without calling the database", async () => {
    const { supabase, rpc } = client({ data: false, error: null });
    expect(await checkSaleSourceUrl(supabase, AMAZON, "https://www.amazon.co.jp/fmc/prime-day")).toBe("allowed");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("asks the database about any other host with the parsed hostname", async () => {
    const { supabase, rpc } = client({ data: true, error: null });
    expect(await checkSaleSourceUrl(supabase, AMAZON, ARTICLE)).toBe("allowed");
    expect(rpc).toHaveBeenCalledWith("is_allowed_manual_source", {
      p_retailer_id: AMAZON.id,
      p_hostname: "www.aboutamazon.jp",
      p_source_url: ARTICLE,
    });
  });

  it.each([
    ["false", { data: false, error: null }],
    ["null", { data: null, error: null }],
    ["a non-boolean", { data: "true", error: null }],
  ])("rejects when the database answers %s", async (_label, result) => {
    const { supabase } = client(result);
    expect(await checkSaleSourceUrl(supabase, AMAZON, ARTICLE)).toBe("rejected");
  });

  it("fails closed on a database error or a thrown request", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await checkSaleSourceUrl(client({ data: true, error: { code: "42501" } }).supabase, AMAZON, ARTICLE)).toBe("failed");
    expect(await checkSaleSourceUrl(client(new TypeError("fetch failed")).supabase, AMAZON, ARTICLE)).toBe("failed");
    expect(error.mock.calls.map(([message]) => message)).toEqual([
      "[admin-data] checkSaleSourceUrl failed: 42501",
      "[admin-data] checkSaleSourceUrl failed: TypeError",
    ]);
    error.mockRestore();
  });

  it("rejects an unparsable URL without calling the database", async () => {
    const { supabase, rpc } = client({ data: true, error: null });
    expect(await checkSaleSourceUrl(supabase, AMAZON, "not a url")).toBe("rejected");
    expect(rpc).not.toHaveBeenCalled();
  });
});

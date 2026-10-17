import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { publishSaleEvent, rejectSaleEvent, archiveSaleEvent, reopenSaleEvent } = await import(
  "./admin-sale-actions"
);

const ID = "33333333-3333-4333-8333-333333333333";
// Microsecond precision, exactly as PostgREST returns it.
const UPDATED_AT = "2026-10-14T03:04:05.123456+00:00";

function client(result: { error: { code?: string; message?: string } | null } | Error) {
  return {
    rpc: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    from: vi.fn(),
  };
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("lifecycle RPC wrappers", () => {
  it.each([
    ["publish", publishSaleEvent, "publish_sale_event"],
    ["archive", archiveSaleEvent, "archive_sale_event"],
    ["reopen", reopenSaleEvent, "reopen_sale_event"],
  ] as const)("%s calls only its stale-checking RPC with the raw page version", async (_label, fn, rpcName) => {
    const c = client({ error: null });
    const args = { p_id: ID, p_expected_updated_at: UPDATED_AT };

    expect(await fn(c as never, ID, UPDATED_AT)).toEqual({ ok: true });
    expect(c.rpc).toHaveBeenCalledTimes(1);
    expect(c.rpc).toHaveBeenCalledWith(rpcName, args);
    expect(c.from).not.toHaveBeenCalled();
  });

  it("reject passes the reason to reject_sale_event", async () => {
    const c = client({ error: null });

    expect(await rejectSaleEvent(c as never, ID, "理由", UPDATED_AT)).toEqual({ ok: true });
    expect(c.rpc).toHaveBeenCalledWith("reject_sale_event", {
      p_id: ID,
      p_reason: "理由",
      p_expected_updated_at: UPDATED_AT,
    });
    expect(c.from).not.toHaveBeenCalled();
  });

  it.each([
    ["wrong state", "P0002"],
    ["not an admin", "42501"],
    ["bad reason", "22023"],
    ["duplicate on reopen", "23505"],
  ])("reports a generic failure for %s and logs only the code", async (_label, code) => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = client({ error: { code, message: "sale event not found or not pending_review secret_detail" } });

    expect(await publishSaleEvent(c as never, ID, UPDATED_AT)).toEqual({ ok: false, reason: "failed" });
    const logged = errorSpy.mock.calls.flat().map(String).join(" ");
    expect(logged).toContain(code);
    expect(logged).not.toContain("secret_detail");
  });

  it.each([
    ["P0409 (stale page)", "P0409"],
    ["40001 (pre-Phase 6O stale code)", "40001"],
  ])("reports %s as stale for every operation", async (_label, code) => {
    const stale = { error: { code, message: "sale event changed since it was loaded" } };

    expect(await publishSaleEvent(client(stale) as never, ID, UPDATED_AT)).toEqual({ ok: false, reason: "stale" });
    expect(await rejectSaleEvent(client(stale) as never, ID, "理由", UPDATED_AT)).toEqual({ ok: false, reason: "stale" });
    expect(await archiveSaleEvent(client(stale) as never, ID, UPDATED_AT)).toEqual({ ok: false, reason: "stale" });
    expect(await reopenSaleEvent(client(stale) as never, ID, UPDATED_AT)).toEqual({ ok: false, reason: "stale" });
  });

  it("treats a thrown error or a missing code as a generic failure", async () => {
    expect(await archiveSaleEvent(client(new TypeError("fetch failed")) as never, ID, UPDATED_AT)).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await archiveSaleEvent(client({ error: {} }) as never, ID, UPDATED_AT)).toEqual({ ok: false, reason: "failed" });
  });
});

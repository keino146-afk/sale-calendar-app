import { describe, expect, it } from "vitest";
import { ADMIN_READ_TIMEOUT_MS, adminReadSignal } from "./admin-read-timeout";

describe("adminReadSignal", () => {
  it("bounds an admin screen read at 10 seconds", () => {
    expect(ADMIN_READ_TIMEOUT_MS).toBe(10_000);
  });

  it("returns a fresh, not yet aborted signal for every read", () => {
    const first = adminReadSignal();
    const second = adminReadSignal();

    expect(first).toBeInstanceOf(AbortSignal);
    expect(first.aborted).toBe(false);
    expect(second).not.toBe(first);
  });
});

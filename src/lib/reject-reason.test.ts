import { describe, expect, it } from "vitest";
import { normalizeRejectReason, REJECT_REASON_MAX_LENGTH } from "./reject-reason";

describe("normalizeRejectReason", () => {
  it("trims surrounding whitespace and keeps inner whitespace", () => {
    expect(normalizeRejectReason("  期間が誤っている \n")).toBe("期間が誤っている");
    expect(normalizeRejectReason("理由 A\n理由 B")).toBe("理由 A\n理由 B");
  });

  it("applies NFKC normalization (full-width spaces and letters)", () => {
    expect(normalizeRejectReason("　ＡＢＣ　理由　")).toBe("ABC 理由");
  });

  it.each([
    ["empty", ""],
    ["spaces only", "   "],
    ["full-width spaces only", "　　"],
    ["tabs and newlines only", "\t\n\r"],
    ["not a string", null],
    ["a file", new Blob(["x"])],
  ])("rejects %s", (_label, value) => {
    expect(normalizeRejectReason(value)).toBeNull();
  });

  it("accepts exactly 2000 characters, counting code points", () => {
    expect(REJECT_REASON_MAX_LENGTH).toBe(2000);
    expect(normalizeRejectReason("あ".repeat(2000))).toHaveLength(2000);
    // Surrogate pairs count as one character, like char_length().
    expect(normalizeRejectReason("😀".repeat(2000))).not.toBeNull();
  });

  it("rejects more than 2000 characters after normalization", () => {
    expect(normalizeRejectReason("あ".repeat(2001))).toBeNull();
    expect(normalizeRejectReason(`  ${"a".repeat(2000)}  `)).toHaveLength(2000);
  });

  it("refuses oversized raw input before normalizing", () => {
    expect(normalizeRejectReason(`a${" ".repeat(20000)}`)).toBeNull();
  });
});

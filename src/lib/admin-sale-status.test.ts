import { describe, expect, it } from "vitest";
import {
  ADMIN_SALE_STATUSES,
  ADMIN_SALE_STATUS_LABELS,
  DEFAULT_ADMIN_SALE_STATUS,
  parseAdminSaleStatus,
} from "./admin-sale-status";

describe("parseAdminSaleStatus", () => {
  it("accepts every known status", () => {
    for (const status of ADMIN_SALE_STATUSES) expect(parseAdminSaleStatus(status)).toBe(status);
  });

  it.each([
    ["missing", undefined],
    ["unknown", "deleted"],
    ["wrong case", "Published"],
    ["empty", ""],
    ["repeated", ["published", "published"]],
    ["prototype key", "toString"],
  ])("falls back to pending_review when %s", (_label, value) => {
    expect(parseAdminSaleStatus(value)).toBe("pending_review");
  });

  it("defaults to pending_review and labels every status in Japanese", () => {
    expect(DEFAULT_ADMIN_SALE_STATUS).toBe("pending_review");
    expect(ADMIN_SALE_STATUSES).toEqual(["pending_review", "published", "rejected", "archived"]);
    expect(ADMIN_SALE_STATUS_LABELS).toEqual({
      pending_review: "確認待ち",
      published: "公開中",
      rejected: "却下",
      archived: "終了",
    });
  });
});

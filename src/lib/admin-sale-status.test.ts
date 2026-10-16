import { describe, expect, it } from "vitest";
import {
  ADMIN_SALE_STATUSES,
  ADMIN_SALE_STATUS_LABELS,
  DEFAULT_ADMIN_SALE_STATUS,
  EDITABLE_SALE_STATUSES,
  isEditableSaleStatus,
  isSalePastEnd,
  PAST_END_FLAGGED_STATUSES,
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

describe("isEditableSaleStatus", () => {
  it("allows editing pending, published and rejected sales but never archived ones", () => {
    expect(EDITABLE_SALE_STATUSES).toEqual(["pending_review", "published", "rejected"]);
    expect(ADMIN_SALE_STATUSES.filter(isEditableSaleStatus)).toEqual(["pending_review", "published", "rejected"]);
    expect(isEditableSaleStatus("archived")).toBe(false);
  });
});

describe("isSalePastEnd", () => {
  const PERIOD = { startsAt: "2026-11-04T11:00:00Z", endsAt: "2026-11-10T17:00:00Z", isDateOnly: false };
  const END = new Date("2026-11-10T17:00:00Z");
  const JUST_BEFORE = new Date("2026-11-10T16:59:59.999Z");

  it.each(["pending_review", "published"] as const)("is true for %s from the exact stored end", (status) => {
    expect(isSalePastEnd({ ...PERIOD, status }, END)).toBe(true);
    expect(isSalePastEnd({ ...PERIOD, status }, JUST_BEFORE)).toBe(false);
  });

  it.each(["rejected", "archived"] as const)("is never true for %s", (status) => {
    expect(isSalePastEnd({ ...PERIOD, status }, new Date("2027-01-01T00:00:00Z"))).toBe(false);
  });

  it("only flags pending and published sales", () => {
    expect(PAST_END_FLAGGED_STATUSES).toEqual(["pending_review", "published"]);
  });
});

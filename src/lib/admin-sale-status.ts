import { getSaleTimingState, type SaleTiming } from "./sale-display";

// Sale event statuses shown in the admin area, in tab order.
export const ADMIN_SALE_STATUSES = ["pending_review", "published", "rejected", "archived"] as const;

export type AdminSaleStatus = (typeof ADMIN_SALE_STATUSES)[number];

export const DEFAULT_ADMIN_SALE_STATUS: AdminSaleStatus = "pending_review";

export const ADMIN_SALE_STATUS_LABELS: Record<AdminSaleStatus, string> = {
  pending_review: "確認待ち",
  published: "公開中",
  rejected: "却下",
  archived: "終了",
};

export function isAdminSaleStatus(value: unknown): value is AdminSaleStatus {
  return typeof value === "string" && (ADMIN_SALE_STATUSES as readonly string[]).includes(value);
}

// Missing, unknown or repeated values fall back to pending_review.
export function parseAdminSaleStatus(value: string | string[] | undefined): AdminSaleStatus {
  return isAdminSaleStatus(value) ? value : DEFAULT_ADMIN_SALE_STATUS;
}

// Statuses whose content an admin may edit. Archived sales stay as they were
// (the database refuses to change them as well).
export const EDITABLE_SALE_STATUSES = ["pending_review", "published", "rejected"] as const satisfies readonly AdminSaleStatus[];

export function isEditableSaleStatus(status: AdminSaleStatus): boolean {
  return (EDITABLE_SALE_STATUSES as readonly AdminSaleStatus[]).includes(status);
}

// Statuses still waiting on an admin (to publish, or to archive) for which a
// period that has already ended is worth flagging. Rejected and archived
// sales are finished in the workflow and are not flagged.
export const PAST_END_FLAGGED_STATUSES = ["pending_review", "published"] as const satisfies readonly AdminSaleStatus[];

// True when the sale's stored (exclusive) end has passed while it is still
// pending or published. Display only: nothing is changed because of it.
export function isSalePastEnd(sale: SaleTiming & { status: AdminSaleStatus }, now: Date): boolean {
  return (
    (PAST_END_FLAGGED_STATUSES as readonly AdminSaleStatus[]).includes(sale.status) &&
    getSaleTimingState(sale, now) === "ended"
  );
}

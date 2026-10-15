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

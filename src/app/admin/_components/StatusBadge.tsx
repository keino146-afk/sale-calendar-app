import { ADMIN_SALE_STATUS_LABELS, type AdminSaleStatus } from "@/lib/admin-sale-status";

const TONES: Record<AdminSaleStatus, string> = {
  pending_review: "bg-amber-100 text-amber-900",
  published: "bg-emerald-100 text-emerald-800",
  rejected: "bg-slate-200 text-slate-700",
  archived: "bg-slate-100 text-slate-500",
};

export function StatusBadge({ status }: { status: AdminSaleStatus }) {
  return (
    <span
      data-status={status}
      className={`rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${TONES[status]}`}
    >
      {ADMIN_SALE_STATUS_LABELS[status]}
    </span>
  );
}

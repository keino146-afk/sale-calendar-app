import Link from "next/link";
import { connection } from "next/server";
import { AdminHeader } from "./_components/AdminHeader";
import { PastEndBadge } from "./_components/PastEndBadge";
import { StatusBadge } from "./_components/StatusBadge";
import { requireAdmin } from "@/server/auth/admin-session";
import {
  countPendingSaleEvents,
  listAdminSaleEvents,
  type AdminSaleEventDto,
} from "@/server/data/admin-sale-events";
import {
  ADMIN_SALE_STATUSES,
  ADMIN_SALE_STATUS_LABELS,
  isSalePastEnd,
  parseAdminSaleStatus,
  type AdminSaleStatus,
} from "@/lib/admin-sale-status";
import { formatJstFullDate } from "@/lib/jst";
import { retailerTone } from "@/lib/retailer-tone";
import { formatSalePeriod } from "@/lib/sale-display";

const EMPTY_TEXT: Record<AdminSaleStatus, string> = {
  pending_review: "確認待ちのセールはありません",
  published: "公開中のセールはありません",
  rejected: "却下したセールはありません",
  archived: "終了したセールはありません",
};

export default async function AdminPage({ searchParams }: PageProps<"/admin">) {
  // Both stay outside try/catch: connection() stops build-time rendering and
  // requireAdmin() redirects by throwing. No data is read before the guard.
  await connection();
  const supabase = await requireAdmin();
  const now = new Date();

  const status = parseAdminSaleStatus((await searchParams).status);

  let sales: AdminSaleEventDto[] | null = null;
  let pendingCount: number | null = null;
  try {
    [sales, pendingCount] = await Promise.all([
      listAdminSaleEvents(supabase, { status }),
      countPendingSaleEvents(supabase),
    ]);
  } catch (error) {
    console.error(`[admin] sale list failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    sales = null;
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-6">
      <AdminHeader />
      {sales === null || pendingCount === null ? (
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">
          セール情報を読み込めませんでした
        </p>
      ) : (
        <>
          <section className="flex items-baseline justify-between rounded-2xl bg-white px-4 py-3 shadow-sm ring-1 ring-black/5">
            <span className="text-sm text-foreground/70">確認待ち</span>
            <span className="text-lg font-bold" data-pending-count={pendingCount}>
              {pendingCount}件
            </span>
          </section>
          <Link
            href="/admin/new"
            className="rounded-2xl bg-blue-500 px-4 py-3 text-center text-[15px] font-semibold text-white shadow-sm"
          >
            新しいセールを登録
          </Link>
          <Link
            href="/admin/collection"
            className="rounded-2xl bg-white px-4 py-3 text-center text-[15px] font-semibold text-blue-600 shadow-sm ring-1 ring-black/5"
          >
            収集候補
          </Link>
          {/* The public page, to check how published sales look to visitors. */}
          <Link
            href="/calendar"
            className="rounded-2xl bg-white px-4 py-3 text-center text-[15px] font-semibold text-blue-600 shadow-sm ring-1 ring-black/5"
          >
            公開カレンダーを見る
          </Link>
          <nav aria-label="状態で絞り込み" className="-mx-4 overflow-x-auto px-4">
            <ul className="flex w-max gap-2">
              {ADMIN_SALE_STATUSES.map((value) => (
                <li key={value}>
                  <Link
                    href={`/admin?status=${value}`}
                    aria-current={value === status ? "page" : undefined}
                    className={`block whitespace-nowrap rounded-full px-4 py-1.5 text-sm ${
                      value === status
                        ? "bg-blue-500 font-semibold text-white shadow-sm"
                        : "border border-black/10 bg-white"
                    }`}
                  >
                    {ADMIN_SALE_STATUS_LABELS[value]}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <AdminSaleList sales={sales} emptyText={EMPTY_TEXT[status]} now={now} />
        </>
      )}
    </main>
  );
}

function AdminSaleList({ sales, emptyText, now }: { sales: AdminSaleEventDto[]; emptyText: string; now: Date }) {
  if (sales.length === 0) {
    return (
      <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm text-foreground/60 shadow-sm">
        {emptyText}
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2.5">
      {sales.map((sale) => (
        <li key={sale.id}>
          <Link
            href={`/admin/sales/${sale.id}`}
            className="flex items-center gap-3 rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-black/5"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-center gap-1.5 text-[11px]">
                <span
                  className={`rounded-md px-1.5 py-0.5 font-semibold ring-1 ${retailerTone(sale.retailer.slug).badge}`}
                >
                  {sale.retailer.name}
                </span>
                <StatusBadge status={sale.status} />
                {isSalePastEnd(sale, now) ? <PastEndBadge /> : null}
              </span>
              <span className="truncate text-[15px] font-semibold">{sale.title}</span>
              <span className="text-xs text-foreground/60">{formatSalePeriod(sale)}</span>
              {sale.sourceCheckedAt !== null ? (
                <span className="text-[11px] text-foreground/50">
                  {formatJstFullDate(new Date(sale.sourceCheckedAt))} 時点の情報
                </span>
              ) : null}
            </span>
            <span aria-hidden="true" className="text-lg text-foreground/30">
              ›
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

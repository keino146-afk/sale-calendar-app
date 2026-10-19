import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { PastEndBadge } from "../../_components/PastEndBadge";
import { SubmitButton } from "../../_components/SubmitButton";
import { StatusBadge } from "../../_components/StatusBadge";
import { archiveSaleAction, publishSaleAction, reopenSaleAction } from "./actions";
import { requireAdmin } from "@/server/auth/admin-session";
import {
  getAdminSaleEvent,
  getLatestRejectReason,
  type AdminSaleEventDto,
} from "@/server/data/admin-sale-events";
import { formatJstDateTime } from "@/lib/jst";
import { formatSalePeriod } from "@/lib/sale-display";
import { isEditableSaleStatus, isSalePastEnd } from "@/lib/admin-sale-status";

type LoadResult =
  | { ok: true; sale: AdminSaleEventDto | null; rejectReason: string | null }
  | { ok: false };

// Only these fixed messages can be shown; query values are never echoed.
// Shown when a still-open sale's period has ended. Nothing is changed
// automatically; the admin decides.
const PAST_END_NOTICES: Partial<Record<AdminSaleEventDto["status"], string>> = {
  published:
    "終了日時を過ぎています。公開ページでは「終了しました」と表示されています。必要に応じて「終了する」を押してください。",
  pending_review:
    "終了日時を過ぎています。このまま公開すると、公開ページでは「終了しました」と表示されます。期間を確認してください。",
};

// Same wording as the edit page's stale message.
const STALE_MESSAGE = "このセールは別の画面ですでに更新されています。最新の内容を確認してからもう一度操作してください";

const DONE_MESSAGES: Record<string, string> = {
  created: "登録しました",
  published: "公開しました",
  rejected: "却下しました",
  archived: "終了しました",
  reopened: "確認待ちに戻しました",
  updated: "変更を保存しました",
};

export default async function AdminSaleDetailPage({
  params,
  searchParams,
}: PageProps<"/admin/sales/[saleId]">) {
  // connection(), requireAdmin() and notFound() all work by throwing and
  // must stay outside try/catch.
  await connection();
  const supabase = await requireAdmin();
  const { saleId } = await params;
  const { done, error } = await searchParams;
  const doneMessage = typeof done === "string" && Object.hasOwn(DONE_MESSAGES, done) ? DONE_MESSAGES[done] : null;

  let result: LoadResult;
  try {
    const sale = await getAdminSaleEvent(supabase, saleId);
    // The audit log is read only for rejected sales.
    const rejectReason = sale?.status === "rejected" ? await getLatestRejectReason(supabase, sale.id) : null;
    result = { ok: true, sale, rejectReason };
  } catch (error) {
    console.error(`[admin] sale detail failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    result = { ok: false };
  }

  if (!result.ok) {
    return (
      <Shell>
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">
          セール情報を読み込めませんでした
        </p>
      </Shell>
    );
  }

  const { sale, rejectReason } = result;
  if (sale === null) notFound();

  const pastEnd = isSalePastEnd(sale, new Date());

  const rows: { label: string; value: ReactNode }[] = [
    { label: "ショップ", value: sale.retailer.name },
    {
      label: "状態",
      value: (
        <span className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={sale.status} />
          {pastEnd ? <PastEndBadge /> : null}
        </span>
      ),
    },
    { label: "期間", value: formatSalePeriod(sale) },
    { label: "期間の種類", value: sale.isDateOnly ? "日付のみ" : "時刻あり" },
    {
      label: "開始",
      value: formatJstDateTime(new Date(sale.startsAt)),
    },
    {
      label: "終了（この時刻を含まない）",
      value: formatJstDateTime(new Date(sale.endsAt)),
    },
    {
      label: "確認日時",
      value: sale.sourceCheckedAt !== null ? formatJstDateTime(new Date(sale.sourceCheckedAt)) : "未設定",
    },
  ];
  if (sale.publishedAt !== null) rows.push({ label: "公開日時", value: formatJstDateTime(new Date(sale.publishedAt)) });
  if (sale.rejectedAt !== null) rows.push({ label: "却下日時", value: formatJstDateTime(new Date(sale.rejectedAt)) });
  if (sale.archivedAt !== null) rows.push({ label: "終了日時", value: formatJstDateTime(new Date(sale.archivedAt)) });

  return (
    <Shell>
      {doneMessage !== null ? (
        <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-center text-sm text-emerald-800">
          {doneMessage}
        </p>
      ) : null}
      {error !== undefined ? (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-center text-sm text-red-700">
          {error === "stale" ? STALE_MESSAGE : "操作を完了できませんでした"}
        </p>
      ) : null}
      {pastEnd ? (
        <p role="note" data-past-end-notice={sale.status} className="rounded-2xl bg-orange-50 px-4 py-3 text-sm text-orange-900">
          {PAST_END_NOTICES[sale.status]}
        </p>
      ) : null}
      <article className="flex flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <h2 className="text-xl font-bold">{sale.title}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-foreground/60">{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        {sale.description !== null ? (
          <section className="flex flex-col gap-1">
            <h3 className="text-sm text-foreground/60">説明</h3>
            <p className="whitespace-pre-wrap text-sm">{sale.description}</p>
          </section>
        ) : null}
        {sale.status === "rejected" ? (
          <section className="flex flex-col gap-1 rounded-xl bg-slate-50 p-3">
            <h3 className="text-sm text-foreground/60">却下理由</h3>
            <p className="whitespace-pre-wrap text-sm">{rejectReason ?? "記録がありません"}</p>
          </section>
        ) : null}
        <section className="flex flex-col gap-1">
          <a
            href={sale.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-fit rounded-full border border-blue-500 px-4 py-2 text-sm font-medium text-blue-600"
          >
            公式ページを見る
          </a>
          <p className="break-all text-xs text-foreground/50">{sale.sourceUrl}</p>
        </section>
      </article>
      {isEditableSaleStatus(sale.status) ? (
        <Link
          href={`/admin/sales/${sale.id}/edit`}
          className="w-full rounded-xl border border-blue-500 bg-white px-4 py-2.5 text-center text-[15px] font-semibold text-blue-600"
        >
          編集する
        </Link>
      ) : null}
      {/* Navigation only: opens the normal create form prefilled with this
          sale's reusable content (any status). Nothing is written here. */}
      <Link
        href={`/admin/new?from=${sale.id}`}
        className="w-full rounded-xl border border-blue-500 bg-white px-4 py-2.5 text-center text-[15px] font-semibold text-blue-600"
      >
        このセールを元に作成
      </Link>
      <LifecycleActions sale={sale} />
    </Shell>
  );
}

function ActionButton({
  action,
  saleId,
  updatedAt,
  label,
  tone,
}: {
  action: (formData: FormData) => Promise<void>;
  saleId: string;
  updatedAt: string;
  label: string;
  tone: "primary" | "danger" | "neutral";
}) {
  const toneClass = {
    primary: "bg-blue-500 text-white",
    danger: "border border-red-300 bg-white text-red-600",
    neutral: "border border-black/10 bg-white",
  }[tone];
  return (
    <form action={action}>
      <input type="hidden" name="saleId" value={saleId} />
      {/* The version this page shows; the RPC refuses the transition if the sale changed since. */}
      <input type="hidden" name="expectedUpdatedAt" value={updatedAt} />
      <SubmitButton className={`w-full rounded-xl px-4 py-2.5 text-[15px] font-semibold ${toneClass}`}>
        {label}
      </SubmitButton>
    </form>
  );
}

// Only the transitions the RPCs allow for the current status are offered.
function LifecycleActions({ sale }: { sale: AdminSaleEventDto }) {
  if (sale.status === "archived") return null;
  return (
    <section aria-label="操作" className="flex flex-col gap-2">
      {sale.status === "pending_review" ? (
        <>
          <ActionButton action={publishSaleAction} saleId={sale.id} updatedAt={sale.updatedAt} label="公開する" tone="primary" />
          <Link
            href={`/admin/sales/${sale.id}/reject`}
            className="w-full rounded-xl border border-red-300 bg-white px-4 py-2.5 text-center text-[15px] font-semibold text-red-600"
          >
            却下する
          </Link>
        </>
      ) : null}
      {sale.status === "published" ? (
        <ActionButton action={archiveSaleAction} saleId={sale.id} updatedAt={sale.updatedAt} label="終了する" tone="danger" />
      ) : null}
      {sale.status === "rejected" ? (
        <ActionButton action={reopenSaleAction} saleId={sale.id} updatedAt={sale.updatedAt} label="確認待ちに戻す" tone="neutral" />
      ) : null}
    </section>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-6">
      <Link href="/admin" className="w-fit text-sm text-blue-600">
        ‹ 一覧へ戻る
      </Link>
      {children}
    </main>
  );
}

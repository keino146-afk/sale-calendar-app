import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { StatusBadge } from "../../_components/StatusBadge";
import { requireAdmin } from "@/server/auth/admin-session";
import { getAdminSaleEvent, type AdminSaleEventDto } from "@/server/data/admin-sale-events";
import { formatJstDateTime } from "@/lib/jst";
import { formatSalePeriod } from "@/lib/sale-display";

type LoadResult = { ok: true; sale: AdminSaleEventDto | null } | { ok: false };

export default async function AdminSaleDetailPage({ params }: PageProps<"/admin/sales/[saleId]">) {
  // connection(), requireAdmin() and notFound() all work by throwing and
  // must stay outside try/catch.
  await connection();
  const supabase = await requireAdmin();
  const { saleId } = await params;

  let result: LoadResult;
  try {
    result = { ok: true, sale: await getAdminSaleEvent(supabase, saleId) };
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

  const { sale } = result;
  if (sale === null) notFound();

  const rows: { label: string; value: ReactNode }[] = [
    { label: "ショップ", value: sale.retailer.name },
    { label: "状態", value: <StatusBadge status={sale.status} /> },
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
    </Shell>
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

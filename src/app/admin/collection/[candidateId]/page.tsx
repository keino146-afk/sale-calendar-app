import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { requireAdmin } from "@/server/auth/admin-session";
import {
  getCollectionCandidate,
  type CollectionCandidateDetail,
} from "@/server/data/admin-collection-candidates";
import { formatJstDateTime } from "@/lib/jst";
import { formatSalePeriod } from "@/lib/sale-display";

type LoadResult = { ok: true; candidate: CollectionCandidateDetail | null } | { ok: false };

const STATE_LABELS = { new: "未確認", imported: "登録済み", dismissed: "見送り" } as const;

export default async function AdminCollectionCandidatePage({
  params,
}: PageProps<"/admin/collection/[candidateId]">) {
  // connection(), requireAdmin() and notFound() throw; keep them outside try/catch.
  await connection();
  const supabase = await requireAdmin();
  const { candidateId } = await params;

  let result: LoadResult;
  try {
    result = { ok: true, candidate: await getCollectionCandidate(supabase, candidateId) };
  } catch (error) {
    console.error(`[admin] collection detail failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    result = { ok: false };
  }

  if (!result.ok) {
    return (
      <Shell>
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">収集候補を読み込めませんでした</p>
      </Shell>
    );
  }
  const { candidate } = result;
  if (candidate === null) notFound();

  const rows: { label: string; value: ReactNode }[] = [
    { label: "ショップ", value: candidate.retailer.name },
    { label: "状態", value: STATE_LABELS[candidate.reviewState] },
    { label: "期間", value: formatSalePeriod(candidate) },
    { label: "期間の種類", value: candidate.isDateOnly ? "日付のみ" : "時刻あり" },
    { label: "開始", value: formatJstDateTime(new Date(candidate.startsAt)) },
    { label: "終了（この時刻を含まない）", value: formatJstDateTime(new Date(candidate.endsAt)) },
    { label: "公式情報の確認日時", value: formatJstDateTime(new Date(candidate.sourceCheckedAt)) },
    { label: "初めて見つけた日時", value: formatJstDateTime(new Date(candidate.firstSeenAt)) },
    { label: "最後に見つけた日時", value: formatJstDateTime(new Date(candidate.lastSeenAt)) },
    { label: "読み取りの版", value: candidate.parserVersion },
  ];

  return (
    <Shell>
      {candidate.sourceChanged ? (
        <p role="alert" data-source-changed="true" className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          収集後に公式情報が変更されています。登録前に公式ページを確認してください。
        </p>
      ) : null}
      <article className="flex flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <h2 className="text-xl font-bold">{candidate.title}</h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {rows.map((row) => (
            <div key={row.label} className="contents">
              <dt className="text-foreground/60">{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
        {candidate.description !== null ? (
          <section className="flex flex-col gap-1">
            <h3 className="text-sm text-foreground/60">説明</h3>
            <p className="whitespace-pre-wrap text-sm">{candidate.description}</p>
          </section>
        ) : null}
        <section className="flex flex-col gap-1 rounded-xl bg-slate-50 p-3">
          <h3 className="text-sm text-foreground/60">読み取った根拠</h3>
          <p className="whitespace-pre-wrap text-sm">{candidate.evidenceExcerpt}</p>
        </section>
        <section className="flex flex-col gap-1">
          <a
            href={candidate.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="w-fit rounded-full border border-blue-500 px-4 py-2 text-sm font-medium text-blue-600"
          >
            公式情報を確認
          </a>
          <p className="break-all text-xs text-foreground/50">{candidate.sourceUrl}</p>
        </section>
      </article>
      <Link
        href={`/admin/new?candidateId=${candidate.id}`}
        className="rounded-xl bg-blue-500 px-4 py-2.5 text-center text-[15px] font-semibold text-white"
      >
        手動登録へ進む
      </Link>
      <p className="text-xs text-foreground/60">
        登録画面に候補の内容が入った状態で開きます。内容を確認・修正してから登録してください。この候補の状態は変わりません。
      </p>
    </Shell>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-6">
      <Link href="/admin/collection" className="w-fit text-sm text-blue-600">
        ‹ 収集候補へ戻る
      </Link>
      {children}
    </main>
  );
}

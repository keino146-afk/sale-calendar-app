import Link from "next/link";
import { connection } from "next/server";
import { requireAdmin } from "@/server/auth/admin-session";
import {
  CANDIDATE_REVIEW_STATES,
  listCollectionCandidates,
  parseCandidateReviewState,
  type CandidateReviewState,
  type CollectionCandidateSummary,
} from "@/server/data/admin-collection-candidates";
import { formatJstDateTime } from "@/lib/jst";
import { retailerTone } from "@/lib/retailer-tone";
import { formatSalePeriod } from "@/lib/sale-display";

const STATE_LABELS: Record<CandidateReviewState, string> = {
  new: "未確認",
  imported: "登録済み",
  dismissed: "見送り",
};

export default async function AdminCollectionPage({ searchParams }: PageProps<"/admin/collection">) {
  // Both stay outside try/catch: connection() stops build-time rendering and
  // requireAdmin() redirects by throwing. No data is read before the guard.
  await connection();
  const supabase = await requireAdmin();
  const reviewState = parseCandidateReviewState((await searchParams).state);

  let candidates: CollectionCandidateSummary[] | null;
  try {
    candidates = await listCollectionCandidates(supabase, { reviewState });
  } catch (error) {
    console.error(`[admin] collection list failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    candidates = null;
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-6">
      <Link href="/admin" className="w-fit text-sm text-blue-600">
        ‹ 管理画面へ戻る
      </Link>
      <h1 className="text-xl font-bold">収集候補</h1>
      <p className="text-sm text-foreground/70">
        自動収集で見つかったセール候補を確認する画面です。候補は公開されません。内容を確認して「手動登録へ進む」から登録します。
      </p>
      <nav aria-label="状態で絞り込み" className="flex gap-2">
        {CANDIDATE_REVIEW_STATES.map((state) => (
          <Link
            key={state}
            href={`/admin/collection?state=${state}`}
            aria-current={state === reviewState ? "page" : undefined}
            className={`rounded-full px-4 py-1.5 text-sm ${
              state === reviewState ? "bg-blue-500 font-semibold text-white shadow-sm" : "border border-black/10 bg-white"
            }`}
          >
            {STATE_LABELS[state]}
          </Link>
        ))}
      </nav>
      {candidates === null ? (
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">収集候補を読み込めませんでした</p>
      ) : candidates.length === 0 ? (
        <section className="flex flex-col gap-1 rounded-2xl bg-white px-4 py-6 text-center shadow-sm">
          <p className="text-sm font-medium">収集候補はありません</p>
          <p className="text-xs text-foreground/60">
            自動収集で見つかったセール候補がここに表示されます。現在、自動収集はまだ有効になっていません。
          </p>
        </section>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {candidates.map((candidate) => (
            <li key={candidate.id}>
              <Link
                href={`/admin/collection/${candidate.id}`}
                className="flex flex-col gap-1 rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-black/5"
              >
                <span className="flex items-center gap-1.5 text-[11px]">
                  <span className={`rounded-md px-1.5 py-0.5 font-semibold ring-1 ${retailerTone(candidate.retailer.slug).badge}`}>
                    {candidate.retailer.name}
                  </span>
                  <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-slate-700">
                    {STATE_LABELS[candidate.reviewState]}
                  </span>
                  {candidate.sourceChanged ? (
                    <span data-source-changed="true" className="rounded-md bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-900">
                      公式情報が変更あり
                    </span>
                  ) : null}
                </span>
                <span className="truncate text-[15px] font-semibold">{candidate.title}</span>
                <span className="text-xs text-foreground/60">{formatSalePeriod(candidate)}</span>
                <span className="text-[11px] text-foreground/50">
                  初回 {formatJstDateTime(new Date(candidate.firstSeenAt))}・最終 {formatJstDateTime(new Date(candidate.lastSeenAt))}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

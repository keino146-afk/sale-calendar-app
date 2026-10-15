import Link from "next/link";
import { connection } from "next/server";
import { createSaleCandidateAction } from "./actions";
import { Field, INPUT_CLASS, SaleContentFields } from "../_components/SaleContentFields";
import { requireAdmin } from "@/server/auth/admin-session";
import { listActiveRetailersForAdmin, type AdminRetailerOption } from "@/server/data/admin-sale-create";
import {
  getCollectionCandidate,
  isCandidateId,
  type CollectionCandidateDetail,
} from "@/server/data/admin-collection-candidates";
import {
  DESCRIPTION_MAX_LENGTH,
  parsePeriodMode,
  saleFormDefaultsFromPeriod,
  toJstDateTimeLocal,
  type PeriodMode,
  type SaleFormDefaults,
} from "@/lib/sale-candidate-form";

// Only these fixed messages can be shown; query values are never echoed.
const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: "入力内容を確認してください",
  retailer: "店舗を選び直してください",
  title: "タイトルを200文字以内で入力してください",
  description: `説明は${DESCRIPTION_MAX_LENGTH}文字以内で入力してください`,
  source_url: "公式ページURLは https:// で始まる正しいURLを入力してください",
  source_domain: "公式ページURLが選んだ店舗の公式サイトではありません",
  checked_at: "情報を確認した日時を正しく入力してください",
  period: "期間を正しく入力してください（終了は開始より後にしてください）",
  duplicate: "同じセールがすでに登録されています",
  candidate_state: "この収集候補はすでに登録済みか、登録できない状態です",
  failed: "登録できませんでした",
};

export default async function AdminNewSalePage({ searchParams }: PageProps<"/admin/new">) {
  // connection() and requireAdmin() throw; keep them outside try/catch.
  await connection();
  const supabase = await requireAdmin();
  const now = new Date();

  const { mode: rawMode, error, candidateId: rawCandidateId } = await searchParams;
  const errorMessage = typeof error === "string" && Object.hasOwn(ERROR_MESSAGES, error) ? ERROR_MESSAGES[error] : null;

  let retailers: AdminRetailerOption[] | null;
  try {
    retailers = await listActiveRetailersForAdmin(supabase);
  } catch (loadError) {
    console.error(`[admin] new sale page failed: ${loadError instanceof Error ? loadError.name : "UnknownError"}`);
    retailers = null;
  }

  // Optional prefill from a collection candidate. Only the id travels in the
  // URL; the content is looked up here as the admin (RLS). A malformed id is
  // ignored without querying. The values are only starting points: the
  // submission goes through createSaleCandidateAction's validation, and the
  // import RPC re-checks everything. Only a candidate that is still new is
  // offered; an imported or dismissed one cannot be registered again.
  const candidateId = isCandidateId(rawCandidateId) ? rawCandidateId : null;
  let candidate: CollectionCandidateDetail | null = null;
  let candidateUnavailable = false;
  let candidateClosed = false;
  if (candidateId !== null) {
    try {
      candidate = await getCollectionCandidate(supabase, candidateId);
    } catch (loadError) {
      console.error(`[admin] candidate prefill failed: ${loadError instanceof Error ? loadError.name : "UnknownError"}`);
    }
    if (candidate !== null && candidate.reviewState !== "new") {
      candidate = null;
      candidateClosed = true;
    }
    candidateUnavailable = candidate === null && !candidateClosed;
  }
  const defaults: SaleFormDefaults | null =
    candidate === null
      ? null
      : saleFormDefaultsFromPeriod({
          retailerId: candidate.retailer.id,
          title: candidate.title,
          description: candidate.description,
          startsAt: new Date(candidate.startsAt),
          endsAt: new Date(candidate.endsAt),
          sourceUrl: candidate.sourceUrl,
          sourceCheckedAt: new Date(candidate.sourceCheckedAt),
        });
  const mode: PeriodMode =
    typeof rawMode === "string" || candidate === null ? parsePeriodMode(rawMode) : candidate.isDateOnly ? "date" : "datetime";

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-6">
      <Link href="/admin" className="w-fit text-sm text-blue-600">
        ‹ 一覧へ戻る
      </Link>
      <h1 className="text-xl font-bold">新しいセールを登録</h1>
      <p className="text-sm text-foreground/70">登録したセールは「確認待ち」になります。公開は詳細画面から行います。</p>
      {errorMessage !== null ? (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-center text-sm text-red-700">
          {errorMessage}
        </p>
      ) : null}
      {candidate !== null ? (
        <p data-prefilled-from-candidate="true" className="rounded-2xl bg-blue-50 px-4 py-3 text-sm text-blue-900">
          収集候補の内容を入力しました。公式ページで内容を確認・修正してから登録してください。
        </p>
      ) : null}
      {candidate?.sourceChanged ? (
        <p role="alert" data-source-changed="true" className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          収集後に公式情報が変更されています。登録前に公式ページを確認してください。
        </p>
      ) : null}
      {candidateClosed ? (
        <p role="alert" data-candidate-closed="true" className="rounded-2xl bg-red-50 px-4 py-3 text-center text-sm text-red-700">
          この収集候補はすでに登録済みか、見送り済みです
        </p>
      ) : null}
      {candidateUnavailable ? (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-center text-sm text-red-700">
          収集候補を読み込めませんでした
        </p>
      ) : null}
      {retailers === null ? (
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">店舗を読み込めませんでした</p>
      ) : (
        <SaleForm
          mode={mode}
          retailers={retailers}
          defaults={defaults}
          candidateId={candidate === null ? null : candidate.id}
          checkedAtDefault={toJstDateTimeLocal(now)}
        />
      )}
    </main>
  );
}

function SaleForm({
  mode,
  retailers,
  defaults,
  candidateId,
  checkedAtDefault,
}: {
  mode: PeriodMode;
  retailers: AdminRetailerOption[];
  defaults: SaleFormDefaults | null;
  candidateId: string | null;
  checkedAtDefault: string;
}) {
  // An inactive retailer is not an option; the admin then chooses again.
  const retailerDefault =
    defaults !== null && retailers.some((retailer) => retailer.id === defaults.retailerId) ? defaults.retailerId : "";
  return (
    <form
      action={createSaleCandidateAction}
      className="flex flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5"
    >
      <input type="hidden" name="mode" value={mode} />
      {candidateId !== null ? <input type="hidden" name="candidateId" value={candidateId} /> : null}
      <Field label="店舗">
        <select name="retailerId" required defaultValue={retailerDefault} className={INPUT_CLASS}>
          <option value="" disabled>
            選んでください
          </option>
          {retailers.map((retailer) => (
            <option key={retailer.id} value={retailer.id}>
              {retailer.name}
            </option>
          ))}
        </select>
      </Field>
      <SaleContentFields
        mode={mode}
        defaults={defaults}
        checkedAtDefault={checkedAtDefault}
        modeHref={(value) => `/admin/new?mode=${value}${candidateId === null ? "" : `&candidateId=${candidateId}`}`}
      />
      <button type="submit" className="rounded-xl bg-blue-500 px-4 py-2.5 text-[15px] font-semibold text-white">
        登録する
      </button>
    </form>
  );
}

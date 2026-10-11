import type { ReactNode } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { createSaleCandidateAction } from "./actions";
import { requireAdmin } from "@/server/auth/admin-session";
import { listActiveRetailersForAdmin, type AdminRetailerOption } from "@/server/data/admin-sale-create";
import { getJstParts } from "@/lib/jst";
import {
  DESCRIPTION_MAX_LENGTH,
  parsePeriodMode,
  SOURCE_URL_MAX_LENGTH,
  type PeriodMode,
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
  failed: "登録できませんでした",
};

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

// Current JST time in datetime-local format, as a convenient default.
function jstNowLocal(now: Date): string {
  const { year, month, day, hour, minute } = getJstParts(now);
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}`;
}

const INPUT_CLASS = "rounded-xl border border-black/10 px-3 py-2 text-base";

export default async function AdminNewSalePage({ searchParams }: PageProps<"/admin/new">) {
  // connection() and requireAdmin() throw; keep them outside try/catch.
  await connection();
  const supabase = await requireAdmin();
  const now = new Date();

  const { mode: rawMode, error } = await searchParams;
  const mode = parsePeriodMode(rawMode);
  const errorMessage = typeof error === "string" && Object.hasOwn(ERROR_MESSAGES, error) ? ERROR_MESSAGES[error] : null;

  let retailers: AdminRetailerOption[] | null;
  try {
    retailers = await listActiveRetailersForAdmin(supabase);
  } catch (loadError) {
    console.error(`[admin] new sale page failed: ${loadError instanceof Error ? loadError.name : "UnknownError"}`);
    retailers = null;
  }

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
      {retailers === null ? (
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">店舗を読み込めませんでした</p>
      ) : (
        <SaleForm mode={mode} retailers={retailers} checkedAtDefault={jstNowLocal(now)} />
      )}
    </main>
  );
}

function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {children}
      {help !== undefined ? <span className="text-xs text-foreground/60">{help}</span> : null}
    </label>
  );
}

function ModeLink({ value, current, children }: { value: PeriodMode; current: PeriodMode; children: ReactNode }) {
  const selected = value === current;
  return (
    <Link
      href={`/admin/new?mode=${value}`}
      aria-current={selected ? "page" : undefined}
      className={`flex-1 rounded-full px-4 py-1.5 text-center text-sm ${
        selected ? "bg-blue-500 font-semibold text-white" : "border border-black/10 bg-white"
      }`}
    >
      {children}
    </Link>
  );
}

function SaleForm({
  mode,
  retailers,
  checkedAtDefault,
}: {
  mode: PeriodMode;
  retailers: AdminRetailerOption[];
  checkedAtDefault: string;
}) {
  return (
    <form
      action={createSaleCandidateAction}
      className="flex flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5"
    >
      <input type="hidden" name="mode" value={mode} />
      <Field label="店舗">
        <select name="retailerId" required defaultValue="" className={INPUT_CLASS}>
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
      <Field label="タイトル">
        <input type="text" name="title" required maxLength={400} className={INPUT_CLASS} />
      </Field>
      <Field label="説明（任意）">
        <textarea name="description" rows={3} maxLength={DESCRIPTION_MAX_LENGTH} className={INPUT_CLASS} />
      </Field>
      <nav aria-label="期間の種類" className="flex gap-2">
        <ModeLink value="date" current={mode}>
          日付のみ
        </ModeLink>
        <ModeLink value="datetime" current={mode}>
          時刻あり
        </ModeLink>
      </nav>
      {mode === "date" ? (
        <>
          <Field label="開始日">
            <input type="date" name="startDate" required className={INPUT_CLASS} />
          </Field>
          <Field label="終了日（この日を含む）">
            <input type="date" name="endDate" required className={INPUT_CLASS} />
          </Field>
        </>
      ) : (
        <>
          <Field label="開始日時（日本時間）">
            <input type="datetime-local" name="startsAt" required className={INPUT_CLASS} />
          </Field>
          <Field label="終了日時（日本時間・この時刻に終了）">
            <input type="datetime-local" name="endsAt" required className={INPUT_CLASS} />
          </Field>
        </>
      )}
      <Field label="公式ページURL" help="セール情報を確認した公式ページを入力してください">
        <input
          type="url"
          name="sourceUrl"
          required
          maxLength={SOURCE_URL_MAX_LENGTH}
          placeholder="https://"
          className={INPUT_CLASS}
        />
      </Field>
      <Field label="情報を確認した日時（日本時間）">
        <input
          type="datetime-local"
          name="sourceCheckedAt"
          required
          defaultValue={checkedAtDefault}
          className={INPUT_CLASS}
        />
      </Field>
      <button type="submit" className="rounded-xl bg-blue-500 px-4 py-2.5 text-[15px] font-semibold text-white">
        登録する
      </button>
    </form>
  );
}

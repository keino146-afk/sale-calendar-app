import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { updateSaleAction } from "./actions";
import { Field, SaleContentFields } from "../../../_components/SaleContentFields";
import { StatusBadge } from "../../../_components/StatusBadge";
import { SubmitButton } from "../../../_components/SubmitButton";
import { requireAdmin } from "@/server/auth/admin-session";
import { getAdminSaleEventForEdit, type EditableSaleDto } from "@/server/data/admin-sale-edit";
import { isEditableSaleStatus } from "@/lib/admin-sale-status";
import {
  DESCRIPTION_MAX_LENGTH,
  parsePeriodMode,
  saleFormDefaultsFromPeriod,
  toJstDateTimeLocal,
  type PeriodMode,
} from "@/lib/sale-candidate-form";

// Only these fixed messages can be shown; query values are never echoed.
const ERROR_MESSAGES: Record<string, string> = {
  invalid_input: "入力内容を確認してください",
  title: "タイトルを200文字以内で入力してください",
  description: `説明は${DESCRIPTION_MAX_LENGTH}文字以内で入力してください`,
  source_url: "公式ページURLは https:// で始まる正しいURLを入力してください",
  source_domain: "公式ページURLがこのセールの店舗の公式サイトではありません",
  checked_at: "情報を確認した日時を正しく入力してください",
  checked_at_not_newer: "公式ページURLを変更した場合は、情報を確認した日時も新しい日時に更新してください",
  period: "期間を正しく入力してください（終了は開始より後にしてください）",
  duplicate: "同じ店舗・タイトル・開始日のセールがすでにあります",
  stale: "このセールは別の画面ですでに更新されています。最新の内容を確認してからもう一度編集してください",
  confirm_published: "公開中の内容が変更されることを確認してから保存してください",
  not_editable: "終了済みのセールは編集できません",
  not_found: "セールが見つかりませんでした",
  failed: "保存できませんでした",
};

export default async function AdminSaleEditPage({
  params,
  searchParams,
}: PageProps<"/admin/sales/[saleId]/edit">) {
  // connection(), requireAdmin() and notFound() all work by throwing and
  // must stay outside try/catch.
  await connection();
  const supabase = await requireAdmin();
  const { saleId } = await params;
  const { mode: rawMode, error } = await searchParams;
  const errorMessage = typeof error === "string" && Object.hasOwn(ERROR_MESSAGES, error) ? ERROR_MESSAGES[error] : null;

  let sale: EditableSaleDto | null;
  try {
    sale = await getAdminSaleEventForEdit(supabase, saleId);
  } catch (loadError) {
    console.error(`[admin] sale edit failed: ${loadError instanceof Error ? loadError.name : "UnknownError"}`);
    return (
      <Shell backHref="/admin" backLabel="一覧へ戻る">
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">セール情報を読み込めませんでした</p>
      </Shell>
    );
  }
  if (sale === null) notFound();

  const detailHref = `/admin/sales/${sale.id}`;
  if (!isEditableSaleStatus(sale.status)) {
    return (
      <Shell backHref={detailHref} backLabel="詳細へ戻る">
        <p role="alert" data-not-editable="true" className="rounded-2xl bg-red-50 px-4 py-3 text-center text-sm text-red-700">
          終了済みのセールは編集できません
        </p>
      </Shell>
    );
  }

  const mode: PeriodMode = typeof rawMode === "string" ? parsePeriodMode(rawMode) : sale.isDateOnly ? "date" : "datetime";
  const defaults = {
    ...saleFormDefaultsFromPeriod({
      retailerId: sale.retailer.id,
      title: sale.title,
      description: sale.description,
      startsAt: new Date(sale.startsAt),
      endsAt: new Date(sale.endsAt),
      sourceUrl: sale.sourceUrl,
      sourceCheckedAt: new Date(sale.sourceCheckedAt ?? sale.startsAt),
    }),
    // A sale without a recorded check time asks for one.
    sourceCheckedAt: sale.sourceCheckedAt === null ? "" : toJstDateTimeLocal(new Date(sale.sourceCheckedAt)),
  };
  const published = sale.status === "published";

  return (
    <Shell backHref={detailHref} backLabel="詳細へ戻る">
      <h1 className="text-xl font-bold">セールを編集</h1>
      <p className="text-sm text-foreground/70">
        保存しても状態（確認待ち・公開中・却下）は変わりません。店舗は変更できません。
      </p>
      {errorMessage !== null ? (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-center text-sm text-red-700">
          {errorMessage}
        </p>
      ) : null}
      {published ? (
        <p role="alert" data-published-warning="true" className="rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-900">
          このセールは現在公開中です。変更を保存すると、一般公開中の内容もすぐに更新されます。
        </p>
      ) : null}
      <form action={updateSaleAction} className="flex flex-col gap-4 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <input type="hidden" name="saleId" value={sale.id} />
        <input type="hidden" name="mode" value={mode} />
        <input type="hidden" name="expectedUpdatedAt" value={sale.updatedAt} />
        <Field label="店舗">
          <p data-retailer-readonly="true" className="flex items-center gap-2 py-1 text-base">
            {sale.retailer.name}
            <StatusBadge status={sale.status} />
          </p>
        </Field>
        <SaleContentFields
          mode={mode}
          defaults={defaults}
          checkedAtDefault=""
          modeHref={(value) => `/admin/sales/${sale.id}/edit?mode=${value}`}
        />
        {published ? (
          <label className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
            <input type="checkbox" name="confirmPublished" value="on" required className="mt-1" />
            公開中の内容が変更されることを確認しました
          </label>
        ) : null}
        <SubmitButton className="rounded-xl bg-blue-500 px-4 py-2.5 text-[15px] font-semibold text-white">
          変更を保存
        </SubmitButton>
        <Link
          href={detailHref}
          className="rounded-xl border border-black/10 bg-white px-4 py-2.5 text-center text-[15px] font-semibold"
        >
          変更せず戻る
        </Link>
      </form>
    </Shell>
  );
}

function Shell({ backHref, backLabel, children }: { backHref: string; backLabel: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-6">
      <Link href={backHref} className="w-fit text-sm text-blue-600">
        ‹ {backLabel}
      </Link>
      {children}
    </main>
  );
}

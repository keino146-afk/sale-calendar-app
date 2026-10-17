import type { ReactNode } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { rejectSaleAction } from "../actions";
import { SubmitButton } from "../../../_components/SubmitButton";
import { requireAdmin } from "@/server/auth/admin-session";
import { getAdminSaleEvent, type AdminSaleEventDto } from "@/server/data/admin-sale-events";
import { REJECT_REASON_MAX_LENGTH } from "@/lib/reject-reason";
import { formatSalePeriod } from "@/lib/sale-display";

type LoadResult = { ok: true; sale: AdminSaleEventDto | null } | { ok: false };

// Dedicated confirmation step for rejecting (no JavaScript dialogs).
export default async function AdminRejectSalePage({
  params,
  searchParams,
}: PageProps<"/admin/sales/[saleId]/reject">) {
  // connection(), requireAdmin() and notFound() throw; keep them outside try/catch.
  await connection();
  const supabase = await requireAdmin();
  const { saleId } = await params;
  const { error } = await searchParams;

  let result: LoadResult;
  try {
    result = { ok: true, sale: await getAdminSaleEvent(supabase, saleId) };
  } catch (loadError) {
    console.error(`[admin] reject page failed: ${loadError instanceof Error ? loadError.name : "UnknownError"}`);
    result = { ok: false };
  }

  if (!result.ok) {
    return (
      <Shell backHref="/admin">
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">
          セール情報を読み込めませんでした
        </p>
      </Shell>
    );
  }

  const { sale } = result;
  if (sale === null) notFound();
  const backHref = `/admin/sales/${sale.id}`;

  if (sale.status !== "pending_review") {
    return (
      <Shell backHref={backHref}>
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">
          このセールは却下できません
        </p>
      </Shell>
    );
  }

  return (
    <Shell backHref={backHref}>
      <section className="flex flex-col gap-1 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
        <span className="text-xs text-foreground/60">{sale.retailer.name}</span>
        <h2 className="text-lg font-bold">{sale.title}</h2>
        <p className="text-sm text-foreground/70">{formatSalePeriod(sale)}</p>
      </section>
      {error === "reason" ? (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-center text-sm text-red-700">
          却下理由を{REJECT_REASON_MAX_LENGTH}文字以内で入力してください
        </p>
      ) : null}
      <form
        action={rejectSaleAction}
        className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5"
      >
        <input type="hidden" name="saleId" value={sale.id} />
        {/* The version this page shows; the RPC refuses the rejection if the sale changed since. */}
        <input type="hidden" name="expectedUpdatedAt" value={sale.updatedAt} />
        <label className="flex flex-col gap-1 text-sm">
          却下理由
          <textarea
            name="reason"
            required
            maxLength={REJECT_REASON_MAX_LENGTH}
            rows={5}
            className="rounded-xl border border-black/10 px-3 py-2 text-base"
          />
        </label>
        <SubmitButton className="rounded-xl bg-red-500 px-4 py-2.5 text-[15px] font-semibold text-white">
          却下を確定する
        </SubmitButton>
        <Link href={backHref} className="text-center text-sm text-blue-600">
          戻る
        </Link>
      </form>
    </Shell>
  );
}

function Shell({ backHref, children }: { backHref: string; children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-6">
      <Link href={backHref} className="w-fit text-sm text-blue-600">
        ‹ 戻る
      </Link>
      <h1 className="text-xl font-bold">セールを却下する</h1>
      {children}
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getPublishedSaleEvent, type SaleEventDto } from "@/server/data/sale-events";
import { formatJstFullDate } from "@/lib/jst";
import { formatSalePeriod } from "@/lib/sale-display";

type LoadResult = { ok: true; sale: SaleEventDto | null } | { ok: false };

export default async function SaleDetailPage({ params }: PageProps<"/sales/[saleId]">) {
  // connection() and notFound() must stay outside try/catch: both work by
  // throwing and must reach Next.js.
  await connection();
  const { saleId } = await params;

  let result: LoadResult;
  try {
    result = { ok: true, sale: await getPublishedSaleEvent(saleId) };
  } catch (error) {
    // Log only the error class; messages may contain upstream details.
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(`[sale-detail] sale load failed: ${errorName}`);
    result = { ok: false };
  }

  if (!result.ok) {
    return (
      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10">
        <p>セール情報を読み込めませんでした</p>
        <BackLink />
      </main>
    );
  }

  const { sale } = result;
  if (sale === null) {
    notFound();
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10">
      <BackLink />
      <article className="flex flex-col gap-4">
        <span className="w-fit rounded border border-foreground/30 px-1.5 py-0.5 text-xs">
          {sale.retailer.name}
        </span>
        <h1 className="text-2xl font-semibold">{sale.title}</h1>
        <p className="text-foreground/80">{formatSalePeriod(sale)}</p>
        {sale.description !== null ? (
          <p className="whitespace-pre-wrap">{sale.description}</p>
        ) : null}
        <a
          href={sale.sourceUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="w-fit rounded-full border border-foreground px-4 py-2 text-sm"
        >
          公式ページを見る
        </a>
        {sale.sourceCheckedAt !== null ? (
          <p className="text-xs text-foreground/60">
            {formatJstFullDate(new Date(sale.sourceCheckedAt))} 時点の情報
          </p>
        ) : null}
      </article>
    </main>
  );
}

function BackLink() {
  return (
    <Link href="/" className="w-fit text-sm underline">
      トップへ戻る
    </Link>
  );
}

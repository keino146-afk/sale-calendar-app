import Link from "next/link";
import { connection } from "next/server";
import { AdminHomeLink } from "@/components/AdminHomeLink";
import { RetailerFilter } from "@/components/RetailerFilter";
import { SaleList, type SaleListItem } from "@/components/SaleList";
import { listActiveRetailers, type RetailerDto } from "@/server/data/retailers";
import { listPublishedSaleEvents, type SaleEventDto } from "@/server/data/sale-events";
import { addDays } from "@/lib/jst";
import {
  classifySales,
  formatPublicSalePeriod,
  isSaleActive,
  UPCOMING_DAYS,
} from "@/lib/sale-display";

function toListItem(sale: SaleEventDto, now: Date): SaleListItem {
  return {
    id: sale.id,
    title: sale.title,
    retailerSlug: sale.retailer.slug,
    retailerName: sale.retailer.name,
    period: formatPublicSalePeriod(sale),
    isActive: isSaleActive(sale, now),
  };
}

export default async function Home({ searchParams }: PageProps<"/">) {
  // Must stay outside try/catch: it interrupts prerendering at build time
  // so Supabase is never read during `next build`.
  await connection();
  const now = new Date();

  const { retailer: requestedRetailer } = await searchParams;

  let retailers: RetailerDto[] | null = null;
  let selectedRetailerSlug: string | undefined;
  let sales: SaleEventDto[] | null = null;
  try {
    retailers = await listActiveRetailers();
    // Only a known active retailer is used as a filter; anything else means "all".
    selectedRetailerSlug = retailers.find(
      (retailer) => retailer.slug === requestedRetailer,
    )?.slug;
    sales = await listPublishedSaleEvents({
      from: now,
      to: addDays(now, UPCOMING_DAYS),
      retailerSlug: selectedRetailerSlug,
    });
  } catch (error) {
    // Log only the error class; messages may contain upstream details.
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(`[home] sale load failed: ${errorName}`);
    sales = null;
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-5 px-4 pb-12 pt-6">
      <header className="relative flex flex-col items-center gap-1 text-center">
        <h1 className="text-2xl font-bold">セールカレンダー</h1>
        <p className="text-xs text-foreground/60">楽天市場・Amazon・Qoo10のセール情報</p>
        {/* Shown to admins only, after a check; positioned so it never shifts the layout. */}
        <div className="absolute right-0 top-0">
          <AdminHomeLink />
        </div>
      </header>
      <Link
        href="/calendar"
        className="flex items-center justify-center gap-2 rounded-2xl bg-blue-500 px-4 py-3 text-[15px] font-semibold text-white shadow-sm active:bg-blue-600"
      >
        カレンダーを見る
        <span aria-hidden="true">›</span>
      </Link>
      {retailers === null || sales === null ? (
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">
          セール情報を読み込めませんでした
        </p>
      ) : (
        <>
          <RetailerFilter retailers={retailers} selectedSlug={selectedRetailerSlug} />
          <HomeSections sales={sales} now={now} />
        </>
      )}
    </main>
  );
}

function HomeSections({ sales, now }: { sales: SaleEventDto[]; now: Date }) {
  const { active, upcoming } = classifySales(sales, now);
  return (
    <>
      <section className="flex flex-col gap-2.5">
        <h2 className="flex items-center gap-2 px-1 text-lg font-bold">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-red-500" />
          開催中
        </h2>
        <SaleList
          items={active.map((sale) => toListItem(sale, now))}
          emptyText="現在開催中のセールはありません"
        />
      </section>
      <section className="flex flex-col gap-2.5">
        <h2 className="flex items-center gap-2 px-1 text-lg font-bold">
          <span aria-hidden="true" className="h-2 w-2 rounded-full bg-blue-500" />
          近日開催
        </h2>
        <SaleList
          items={upcoming.map((sale) => toListItem(sale, now))}
          emptyText="近日開催予定のセールはありません"
        />
      </section>
    </>
  );
}

import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { AdminHomeLink } from "@/components/AdminHomeLink";
import { RetailerFilter } from "@/components/RetailerFilter";
import { SaleList, type SaleListItem } from "@/components/SaleList";
import { listActiveRetailers, type RetailerDto } from "@/server/data/retailers";
import {
  getNextPublishedSaleEvent,
  listPublishedSaleEvents,
  type SaleEventDto,
} from "@/server/data/sale-events";
import { addDays } from "@/lib/jst";
import { publicPageMetadata, SITE_DESCRIPTION } from "@/lib/site";
import {
  classifySales,
  formatPublicSalePeriod,
  isSaleActive,
  UPCOMING_DAYS,
} from "@/lib/sale-display";

// The root default title (no template on the home page). The canonical URL
// ignores ?retailer=, so every filtered view points at "/".
export const metadata: Metadata = publicPageMetadata({ path: "/", description: SITE_DESCRIPTION });

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
  // One boundary for both the upcoming window and the next-sale hint, so a
  // sale is in exactly one of them.
  const upcomingEnd = addDays(now, UPCOMING_DAYS);

  let sales: SaleEventDto[] | null = null;
  try {
    retailers = await listActiveRetailers();
    // Only a known active retailer is used as a filter; anything else means "all".
    selectedRetailerSlug = retailers.find(
      (retailer) => retailer.slug === requestedRetailer,
    )?.slug;
    sales = await listPublishedSaleEvents({
      from: now,
      to: upcomingEnd,
      retailerSlug: selectedRetailerSlug,
    });
  } catch (error) {
    // Log only the error class; messages may contain upstream details.
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(`[home] sale load failed: ${errorName}`);
    sales = null;
  }

  // Only when nothing starts within the window: the first published sale
  // after it, as a hint. A failure here hides the hint, not the page.
  const classified = sales === null ? null : classifySales(sales, now);
  let nextSale: SaleEventDto | null = null;
  if (classified !== null && classified.upcoming.length === 0) {
    try {
      nextSale = await getNextPublishedSaleEvent({
        after: upcomingEnd,
        retailerSlug: selectedRetailerSlug,
      });
    } catch (error) {
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.error(`[home] next sale load failed: ${errorName}`);
      nextSale = null;
    }
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
      {retailers === null || classified === null ? (
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">
          セール情報を読み込めませんでした
        </p>
      ) : (
        <>
          <RetailerFilter retailers={retailers} selectedSlug={selectedRetailerSlug} />
          <HomeSections {...classified} nextSale={nextSale} now={now} />
        </>
      )}
    </main>
  );
}

function HomeSections({
  active,
  upcoming,
  nextSale,
  now,
}: {
  active: SaleEventDto[];
  upcoming: SaleEventDto[];
  nextSale: SaleEventDto | null;
  now: Date;
}) {
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
        {nextSale !== null ? (
          <div className="flex flex-col gap-2 pt-1" data-next-sale>
            <h3 className="px-1 text-sm font-semibold text-foreground/60">次回開催予定</h3>
            <SaleList items={[toListItem(nextSale, now)]} emptyText="" />
          </div>
        ) : null}
      </section>
    </>
  );
}

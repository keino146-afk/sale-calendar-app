import { connection } from "next/server";
import { RetailerFilter } from "@/components/RetailerFilter";
import { SaleList, type SaleListItem } from "@/components/SaleList";
import { listActiveRetailers, type RetailerDto } from "@/server/data/retailers";
import { listPublishedSaleEvents, type SaleEventDto } from "@/server/data/sale-events";
import { addDays } from "@/lib/jst";
import {
  classifySales,
  formatSalePeriod,
  isSaleActive,
  UPCOMING_DAYS,
} from "@/lib/sale-display";

function toListItem(sale: SaleEventDto, now: Date): SaleListItem {
  return {
    id: sale.id,
    title: sale.title,
    retailerName: sale.retailer.name,
    period: formatSalePeriod(sale),
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
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10">
      <h1 className="text-2xl font-semibold">セールカレンダー</h1>
      {retailers === null || sales === null ? (
        <p>セール情報を読み込めませんでした</p>
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
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">開催中</h2>
        <SaleList
          items={active.map((sale) => toListItem(sale, now))}
          emptyText="現在開催中のセールはありません"
        />
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">近日開催</h2>
        <SaleList
          items={upcoming.map((sale) => toListItem(sale, now))}
          emptyText="近日開催予定のセールはありません"
        />
      </section>
    </>
  );
}

import type { ReactNode } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { MonthGrid, type MonthGridEvent } from "@/components/MonthGrid";
import { RetailerFilter } from "@/components/RetailerFilter";
import { SaleList } from "@/components/SaleList";
import { listActiveRetailers, type RetailerDto } from "@/server/data/retailers";
import { listPublishedSaleEvents, type SaleEventDto } from "@/server/data/sale-events";
import {
  assignEventsToDays,
  buildCalendarDays,
  calendarHref,
  calendarRange,
  filterMonthSales,
  resolveYearMonth,
  shiftMonth,
  type YearMonth,
} from "@/lib/calendar-grid";
import { formatSalePeriod, isSaleActive, type SaleTiming } from "@/lib/sale-display";

export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  // Must stay outside try/catch: it interrupts prerendering at build time
  // so Supabase is never read during `next build`.
  await connection();
  const now = new Date();

  const { year, month, retailer: requestedRetailer } = await searchParams;
  const yearMonth = resolveYearMonth(year, month, now);

  let retailers: RetailerDto[] | null = null;
  let selectedRetailerSlug: string | undefined;
  let sales: SaleEventDto[] | null = null;
  try {
    retailers = await listActiveRetailers();
    // Only a known active retailer is used as a filter; anything else means "all".
    selectedRetailerSlug = retailers.find(
      (retailer) => retailer.slug === requestedRetailer,
    )?.slug;
    const { from, to } = calendarRange(yearMonth);
    sales = await listPublishedSaleEvents({ from, to, retailerSlug: selectedRetailerSlug });
  } catch (error) {
    // Log only the error class; messages may contain upstream details.
    const errorName = error instanceof Error ? error.name : "UnknownError";
    console.error(`[calendar] sale load failed: ${errorName}`);
    sales = null;
  }

  return (
    <main className="mx-auto flex w-full max-w-xl flex-1 flex-col gap-6 px-4 py-10">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">セールカレンダー</h1>
        <Link href="/" className="text-sm underline">
          トップへ
        </Link>
      </div>
      {retailers === null || sales === null ? (
        <p>セール情報を読み込めませんでした</p>
      ) : (
        <CalendarContent
          yearMonth={yearMonth}
          retailers={retailers}
          selectedRetailerSlug={selectedRetailerSlug}
          sales={sales}
          now={now}
        />
      )}
    </main>
  );
}

type CalendarContentProps = {
  yearMonth: YearMonth;
  retailers: RetailerDto[];
  selectedRetailerSlug: string | undefined;
  sales: SaleEventDto[];
  now: Date;
};

function CalendarContent({
  yearMonth,
  retailers,
  selectedRetailerSlug,
  sales,
  now,
}: CalendarContentProps) {
  const gridEvents = sales.map((sale): MonthGridEvent & SaleTiming => ({
    startsAt: sale.startsAt,
    endsAt: sale.endsAt,
    isDateOnly: sale.isDateOnly,
    id: sale.id,
    title: sale.title,
    retailerName: sale.retailer.name,
  }));
  const cells = assignEventsToDays(buildCalendarDays(yearMonth, now), gridEvents);
  const monthItems = filterMonthSales(sales, yearMonth).map((sale) => ({
    id: sale.id,
    title: sale.title,
    retailerName: sale.retailer.name,
    period: formatSalePeriod(sale),
    isActive: isSaleActive(sale, now),
  }));

  return (
    <>
      <RetailerFilter
        retailers={retailers}
        selectedSlug={selectedRetailerSlug}
        hrefFor={(slug) => calendarHref(yearMonth, slug)}
      />
      <nav aria-label="月の切り替え" className="flex items-center justify-between gap-2">
        <MonthLink target={shiftMonth(yearMonth, -1)} retailerSlug={selectedRetailerSlug}>
          前の月
        </MonthLink>
        <div className="flex flex-col items-center">
          <h2 className="text-lg font-medium">
            {yearMonth.year}年{yearMonth.month}月
          </h2>
          <Link href={calendarHref(null, selectedRetailerSlug)} className="text-xs underline">
            今月
          </Link>
        </div>
        <MonthLink target={shiftMonth(yearMonth, 1)} retailerSlug={selectedRetailerSlug}>
          次の月
        </MonthLink>
      </nav>
      <MonthGrid cells={cells} />
      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">この月のセール</h2>
        <SaleList items={monthItems} emptyText="この月のセールはありません" />
      </section>
    </>
  );
}

function MonthLink({
  target,
  retailerSlug,
  children,
}: {
  target: YearMonth | null;
  retailerSlug: string | undefined;
  children: ReactNode;
}) {
  const className = "rounded-full border border-foreground/30 px-3 py-1 text-sm";
  if (target === null) {
    return <span className={`${className} opacity-40`}>{children}</span>;
  }
  return (
    <Link href={calendarHref(target, retailerSlug)} className={className}>
      {children}
    </Link>
  );
}

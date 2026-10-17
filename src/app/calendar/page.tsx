import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { cache } from "react";
import { MonthGrid, type MonthGridEvent } from "@/components/MonthGrid";
import { RetailerFilter } from "@/components/RetailerFilter";
import { SaleList, type SaleListItem } from "@/components/SaleList";
import { SiteFooter } from "@/components/SiteFooter";
import { listActiveRetailers, type RetailerDto } from "@/server/data/retailers";
import { listPublishedSaleEvents, type SaleEventDto } from "@/server/data/sale-events";
import {
  assignEventsToDays,
  buildCalendarDays,
  buildCalendarWeeks,
  calendarHref,
  calendarRange,
  filterMonthSales,
  formatDayHeading,
  resolveSelectedDay,
  resolveYearMonth,
  shiftMonth,
  type YearMonth,
} from "@/lib/calendar-grid";
import { formatPublicSalePeriod, isSaleActive, type SaleTiming } from "@/lib/sale-display";
import { publicPageMetadata } from "@/lib/site";

type CalendarData =
  | {
      ok: true;
      now: Date;
      yearMonth: YearMonth;
      retailers: RetailerDto[];
      selectedRetailerSlug: string | undefined;
      sales: SaleEventDto[];
    }
  | { ok: false; now: Date; yearMonth: YearMonth };

// Repeated parameters arrive as arrays; like every non-string value they
// never matched before (a month falls back to the current one, a retailer to
// "all"). Only primitives reach the cached loader, so the page and
// generateMetadata share one cache entry.
function stringParam(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// The page's read (retailers, then the month's sales), once per request:
// React cache() shares the result between generateMetadata and the page and
// keeps nothing across requests. ?day= only selects within the month, so it
// is not part of the key. Failures are returned, not thrown.
const loadCalendarData = cache(
  async (
    yearParam: string | undefined,
    monthParam: string | undefined,
    requestedRetailer: string | undefined,
  ): Promise<CalendarData> => {
    const now = new Date();
    const yearMonth = resolveYearMonth(yearParam, monthParam, now);
    try {
      const retailers = await listActiveRetailers();
      // Only a known active retailer is used as a filter; anything else means "all".
      const selectedRetailerSlug = retailers.find((retailer) => retailer.slug === requestedRetailer)?.slug;
      const { from, to } = calendarRange(yearMonth);
      const sales = await listPublishedSaleEvents({ from, to, retailerSlug: selectedRetailerSlug });
      return { ok: true, now, yearMonth, retailers, selectedRetailerSlug, sales };
    } catch (error) {
      // Log only the error class; messages may contain upstream details.
      const errorName = error instanceof Error ? error.name : "UnknownError";
      console.error(`[calendar] sale load failed: ${errorName}`);
      return { ok: false, now, yearMonth };
    }
  },
);

// One canonical URL for every month and day view (?year=&month=&day=). When
// the read failed, the page shows an error (HTTP 200) and is kept out of the
// index; links on it may still be followed.
export async function generateMetadata({ searchParams }: PageProps<"/calendar">): Promise<Metadata> {
  // Before any read, so `next build` never reads Supabase.
  await connection();
  const { year, month, retailer } = await searchParams;
  const data = await loadCalendarData(stringParam(year), stringParam(month), stringParam(retailer));

  const metadata = publicPageMetadata({
    path: "/calendar",
    title: "カレンダー",
    description: "楽天市場・Amazon・Qoo10の大型セールの予定を月ごとのカレンダーで確認できます。",
  });
  return data.ok ? metadata : { ...metadata, robots: { index: false } };
}

export default async function CalendarPage({ searchParams }: PageProps<"/calendar">) {
  // Must stay outside try/catch: it interrupts prerendering at build time
  // so Supabase is never read during `next build`.
  await connection();

  const { year, month, day, retailer } = await searchParams;
  const data = await loadCalendarData(stringParam(year), stringParam(month), stringParam(retailer));
  const { now, yearMonth } = data;
  const retailers = data.ok ? data.retailers : null;
  const selectedRetailerSlug = data.ok ? data.selectedRetailerSlug : undefined;
  const sales = data.ok ? data.sales : null;

  return (
    <>
      <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-3 px-4 pb-12 pt-3">
        <header className="grid grid-cols-[1fr_auto_1fr] items-center">
          <Link
            href="/"
            aria-label="ホームへ戻る"
            className="flex h-9 w-9 items-center justify-center rounded-full text-blue-500"
          >
            <ChevronIcon direction="left" />
          </Link>
          <h1 className="text-[17px] font-semibold">カレンダー</h1>
          <Link
            href={calendarHref(null, selectedRetailerSlug)}
            aria-label="今日を表示"
            className="justify-self-end rounded-full border border-blue-500 px-3 py-1 text-sm font-medium text-blue-500"
          >
            今日
          </Link>
        </header>
        {retailers === null || sales === null ? (
          <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">
            セール情報を読み込めませんでした
          </p>
        ) : (
          <CalendarContent
            yearMonth={yearMonth}
            dayParam={day}
            retailers={retailers}
            selectedRetailerSlug={selectedRetailerSlug}
            sales={sales}
            now={now}
          />
        )}
      </main>
      <SiteFooter />
    </>
  );
}

type CalendarContentProps = {
  yearMonth: YearMonth;
  dayParam: string | string[] | undefined;
  retailers: RetailerDto[];
  selectedRetailerSlug: string | undefined;
  sales: SaleEventDto[];
  now: Date;
};

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

function CalendarContent({
  yearMonth,
  dayParam,
  retailers,
  selectedRetailerSlug,
  sales,
  now,
}: CalendarContentProps) {
  const days = buildCalendarDays(yearMonth, now);
  const selectedDay = resolveSelectedDay(dayParam, days);
  const gridEvents = sales.map(
    (sale): MonthGridEvent & SaleTiming & { sale: SaleEventDto } => ({
      startsAt: sale.startsAt,
      endsAt: sale.endsAt,
      isDateOnly: sale.isDateOnly,
      id: sale.id,
      title: sale.title,
      retailerSlug: sale.retailer.slug,
      retailerName: sale.retailer.name,
      sale,
    }),
  );
  const weeks = buildCalendarWeeks(days, gridEvents);
  const selectedEvents =
    assignEventsToDays([selectedDay], gridEvents)[0]?.events.map((event) => event.sale) ?? [];
  const monthItems = filterMonthSales(sales, yearMonth).map((sale) => toListItem(sale, now));

  return (
    <>
      <RetailerFilter
        retailers={retailers}
        selectedSlug={selectedRetailerSlug}
        hrefFor={(slug) => calendarHref(yearMonth, slug, selectedDay.key)}
      />
      <section
        aria-label="月間カレンダー"
        className="flex flex-col gap-1.5 rounded-2xl bg-white px-2 pb-2 pt-1.5 shadow-sm ring-1 ring-black/5"
      >
        <nav aria-label="月の切り替え" className="flex items-center justify-between px-1">
          <MonthLink
            target={shiftMonth(yearMonth, -1)}
            retailerSlug={selectedRetailerSlug}
            label="前の月"
          >
            <ChevronIcon direction="left" />
          </MonthLink>
          <h2 className="text-base font-semibold">
            {yearMonth.year}年{yearMonth.month}月
          </h2>
          <MonthLink
            target={shiftMonth(yearMonth, 1)}
            retailerSlug={selectedRetailerSlug}
            label="次の月"
          >
            <ChevronIcon direction="right" />
          </MonthLink>
        </nav>
        <MonthGrid
          weeks={weeks}
          selectedKey={selectedDay.key}
          dayHref={(dayKey) => calendarHref(yearMonth, selectedRetailerSlug, dayKey)}
        />
      </section>
      <section aria-labelledby="selected-day-heading" className="flex flex-col gap-2 pt-1">
        <div className="flex items-baseline justify-between px-1">
          <h2 id="selected-day-heading" className="text-lg font-bold">
            {formatDayHeading(selectedDay)}
          </h2>
          <span className="text-sm text-foreground/60">{selectedEvents.length}件のセール</span>
        </div>
        <SaleList
          items={selectedEvents.map((sale) => toListItem(sale, now))}
          emptyText="この日のセールはありません"
        />
      </section>
      <section aria-labelledby="month-sales-heading" className="mt-2 flex flex-col gap-2">
        <h2 id="month-sales-heading" className="px-1 text-sm font-semibold text-foreground/60">
          この月のセール
        </h2>
        <SaleList items={monthItems} emptyText="この月のセールはありません" />
      </section>
    </>
  );
}

function MonthLink({
  target,
  retailerSlug,
  label,
  children,
}: {
  target: YearMonth | null;
  retailerSlug: string | undefined;
  label: string;
  children: ReactNode;
}) {
  const className = "flex h-8 w-8 items-center justify-center rounded-full";
  if (target === null) {
    return (
      <span aria-label={label} aria-disabled="true" className={`${className} text-slate-300`}>
        {children}
      </span>
    );
  }
  return (
    <Link
      href={calendarHref(target, retailerSlug)}
      aria-label={label}
      className={`${className} text-blue-500 active:bg-blue-50`}
    >
      {children}
    </Link>
  );
}

function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-5 w-5"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={direction === "left" ? "M15 5l-7 7 7 7" : "M9 5l7 7-7 7"} />
    </svg>
  );
}

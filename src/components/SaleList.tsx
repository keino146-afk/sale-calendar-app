import Link from "next/link";
import { retailerTone } from "@/lib/retailer-tone";

export type SaleListItem = {
  id: string;
  title: string;
  retailerSlug: string;
  retailerName: string;
  period: string;
  isActive: boolean;
};

type SaleListProps = {
  items: readonly SaleListItem[];
  emptyText: string;
};

export function SaleList({ items, emptyText }: SaleListProps) {
  if (items.length === 0) {
    return (
      <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm text-foreground/60 shadow-sm">
        {emptyText}
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-2.5">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={`/sales/${item.id}`}
            className="flex items-center gap-3 rounded-2xl bg-white p-3.5 shadow-sm ring-1 ring-black/5 active:bg-slate-50"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-center gap-1.5 text-[11px]">
                <span
                  className={`rounded-md px-1.5 py-0.5 font-semibold ring-1 ${retailerTone(item.retailerSlug).badge}`}
                >
                  {item.retailerName}
                </span>
                {item.isActive ? (
                  <span className="rounded-md bg-red-500 px-1.5 py-0.5 font-semibold text-white">
                    開催中
                  </span>
                ) : null}
              </span>
              <span className="truncate text-[15px] font-semibold">{item.title}</span>
              <span className="text-xs text-foreground/60">{item.period}</span>
            </span>
            <span aria-hidden="true" className="text-lg text-foreground/30">
              ›
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

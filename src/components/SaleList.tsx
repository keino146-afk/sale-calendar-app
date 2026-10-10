import Link from "next/link";

export type SaleListItem = {
  id: string;
  title: string;
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
    return <p className="text-sm text-foreground/70">{emptyText}</p>;
  }

  return (
    <ul className="flex flex-col gap-3">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            href={`/sales/${item.id}`}
            className="flex flex-col gap-1 rounded-lg border border-foreground/15 p-3 hover:bg-foreground/5"
          >
            <span className="flex items-center gap-2 text-xs">
              <span className="rounded border border-foreground/30 px-1.5 py-0.5">
                {item.retailerName}
              </span>
              {item.isActive ? (
                <span className="rounded bg-red-600 px-1.5 py-0.5 text-white">開催中</span>
              ) : null}
            </span>
            <span className="font-medium">{item.title}</span>
            <span className="text-sm text-foreground/70">{item.period}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

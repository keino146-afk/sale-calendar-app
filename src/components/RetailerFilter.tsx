import Link from "next/link";

type RetailerOption = {
  slug: string;
  name: string;
};

type RetailerFilterProps = {
  retailers: readonly RetailerOption[];
  selectedSlug?: string;
};

function linkClass(selected: boolean): string {
  return selected
    ? "rounded-full border border-foreground bg-foreground px-3 py-1 text-sm text-background"
    : "rounded-full border border-foreground/30 px-3 py-1 text-sm";
}

// Plain links only: changing the filter re-renders the Server Component.
export function RetailerFilter({ retailers, selectedSlug }: RetailerFilterProps) {
  return (
    <nav aria-label="ショップで絞り込み">
      <ul className="flex flex-wrap gap-2">
        <li>
          <Link
            href="/"
            className={linkClass(selectedSlug === undefined)}
            aria-current={selectedSlug === undefined ? "page" : undefined}
          >
            すべて
          </Link>
        </li>
        {retailers.map((retailer) => (
          <li key={retailer.slug}>
            <Link
              href={`/?retailer=${encodeURIComponent(retailer.slug)}`}
              className={linkClass(selectedSlug === retailer.slug)}
              aria-current={selectedSlug === retailer.slug ? "page" : undefined}
            >
              {retailer.name}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

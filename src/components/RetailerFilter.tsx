import Link from "next/link";

type RetailerOption = {
  slug: string;
  name: string;
};

type RetailerFilterProps = {
  retailers: readonly RetailerOption[];
  selectedSlug?: string;
  // Builds the link for a retailer (undefined = all). Defaults to the home page.
  hrefFor?: (slug: string | undefined) => string;
};

function homeHref(slug: string | undefined): string {
  return slug === undefined ? "/" : `/?retailer=${encodeURIComponent(slug)}`;
}

function linkClass(selected: boolean): string {
  const base = "block whitespace-nowrap rounded-full px-4 py-1.5 text-sm transition-colors";
  return selected
    ? `${base} bg-blue-500 font-semibold text-white shadow-sm`
    : `${base} border border-black/10 bg-white text-foreground`;
}

// Plain links only: changing the filter re-renders the Server Component.
// Pills scroll horizontally instead of wrapping when space is short.
export function RetailerFilter({
  retailers,
  selectedSlug,
  hrefFor = homeHref,
}: RetailerFilterProps) {
  return (
    <nav aria-label="ショップで絞り込み" className="-mx-4 overflow-x-auto px-4">
      <ul className="flex w-max gap-2">
        <li>
          <Link
            href={hrefFor(undefined)}
            className={linkClass(selectedSlug === undefined)}
            aria-current={selectedSlug === undefined ? "page" : undefined}
          >
            すべて
          </Link>
        </li>
        {retailers.map((retailer) => (
          <li key={retailer.slug}>
            <Link
              href={hrefFor(retailer.slug)}
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

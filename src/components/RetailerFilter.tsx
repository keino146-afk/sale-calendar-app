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
  return selected
    ? "rounded-full border border-foreground bg-foreground px-3 py-1 text-sm text-background"
    : "rounded-full border border-foreground/30 px-3 py-1 text-sm";
}

// Plain links only: changing the filter re-renders the Server Component.
export function RetailerFilter({
  retailers,
  selectedSlug,
  hrefFor = homeHref,
}: RetailerFilterProps) {
  return (
    <nav aria-label="ショップで絞り込み">
      <ul className="flex flex-wrap gap-2">
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

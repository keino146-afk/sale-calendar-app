import type { Normalizer, ParsedCandidate, Parser, SourceAdapter, SourceDescriptor } from "../../contract";
import { parseRssItems } from "../../rss";
import { canonicalizeSourceUrl } from "../../url";
import { extractSaleDateRange } from "./date-range";

// Amazon official news feed (www.aboutamazon.jp), offline parts only: the
// feed is read from a document handed in by an injected Fetcher, so this
// module performs no network access. Whether the live feed may be collected
// automatically is a separate decision; the database source stays disabled.

export const AMAZON_NEWS_PARSER_VERSION = "amazon-news-rss-v1";

// Mirrors the database source policy 'amazon-aboutamazon-news' (manual_source_policy migration).
export const AMAZON_NEWS_SOURCE: SourceDescriptor = {
  sourceId: "amazon-aboutamazon-news",
  retailerSlug: "amazon",
  expectedHost: "www.aboutamazon.jp",
  sourceUrlPattern: /^https:\/\/www\.aboutamazon\.jp\/news\/[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/,
  parserVersion: AMAZON_NEWS_PARSER_VERSION,
};

export const AMAZON_NEWS_FEED_URL = "https://www.aboutamazon.jp/rss/feed.rss";

// Conservative v1: only titles that clearly announce a sale. Other news is
// not a candidate at all.
const SALE_TITLE = /セール|プライムデー|ブラックフライデー/u;

// One raw item per feed item. Dates stay null here; the normalizer decides.
// The description is carried only so the normalizer can cross-check dates;
// it is never stored.
export const amazonNewsParser: Parser = {
  parse(document) {
    return parseRssItems(document.body).map(
      (item): ParsedCandidate => ({
        externalKey: item.link ?? "",
        sourceUrl: item.link ?? "",
        title: item.title ?? "",
        description: item.description,
        startsAt: null,
        endsAt: null,
        isDateOnly: null,
        evidenceExcerpt: item.title ?? "",
      }),
    );
  },
};

export const amazonNewsNormalizer: Normalizer = {
  normalize(item) {
    if (!SALE_TITLE.test(item.title.normalize("NFKC"))) return null;

    // Identity is the canonical article URL (no fragment or tracking
    // parameters), not the GUID. An unusable link stays as given so the
    // validator rejects it.
    const url = canonicalizeSourceUrl(item.sourceUrl) ?? item.sourceUrl;
    const period = extractSaleDateRange([item.title, item.description]);
    const title = item.title.trim();
    return {
      externalKey: url,
      sourceUrl: url,
      title,
      description: null,
      startsAt: period.ok ? period.range.startsAt : null,
      endsAt: period.ok ? period.range.endsAt : null,
      isDateOnly: period.ok ? false : null,
      // Plain text only: the title, plus the period wording when it came from
      // the description.
      evidenceExcerpt:
        period.ok && !title.normalize("NFKC").includes(period.range.text) ? `${title}\n${period.range.text}` : title,
    };
  },
};

export const amazonNewsAdapter: SourceAdapter = {
  source: AMAZON_NEWS_SOURCE,
  documentUrl: AMAZON_NEWS_FEED_URL,
  parser: amazonNewsParser,
  normalizer: amazonNewsNormalizer,
};

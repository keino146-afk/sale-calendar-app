import type { Normalizer, Parser, SourceAdapter, SourceDescriptor } from "../../contract";
import { feedCandidate, feedItemParser } from "../../feed-candidate";
import { extractSaleDateRange } from "./date-range";

// Amazon official news feed (www.aboutamazon.jp), offline parts only: the
// feed is read from a document handed in by an injected Fetcher, so this
// module performs no network access.

// Live collection decision (Phase 5D-2): BLOCKED PENDING PERMISSION.
//
// The About Amazon Japan news pages link to the Amazon.co.jp conditions of
// use, which restrict data mining, robots and data gathering or extraction
// tools unless expressly permitted. No official condition was found that
// expressly permits this app to retrieve the feed automatically, parse it and
// generate database candidates from it. The feed being public is not treated
// as permission. This is a conservative product decision, not a legal
// conclusion: without confirmed permission, live collection stays off.
//
// Live collection may be reconsidered only when one of these is confirmed and
// recorded, never on a developer's judgment alone:
//   A. Amazon / About Amazon expressly permits this use;
//   B. official terms for the About Amazon Japan feed clearly allow automated
//      retrieval and reuse for this purpose;
//   C. a formal (e.g. legal) review approves this specific use.
// Until then: no real Fetcher for this source, no schedule, and the database
// source stays enabled = false. Admins can still cite About Amazon articles
// by hand as an approved official source (allow_manual_source), which is a
// separate permission. live-source-gate.test.ts fails if any of this changes.
export const AMAZON_NEWS_LIVE_COLLECTION_STATUS = "blocked_pending_permission";

export const AMAZON_NEWS_PARSER_VERSION = "amazon-news-rss-v1";

// Mirrors the database source policy 'amazon-aboutamazon-news' (manual_source_policy migration).
export const AMAZON_NEWS_SOURCE: SourceDescriptor = {
  sourceId: "amazon-aboutamazon-news",
  retailerSlug: "amazon",
  expectedHost: "www.aboutamazon.jp",
  sourceUrlPattern: /^https:\/\/www\.aboutamazon\.jp\/news\/[a-z0-9]+(-[a-z0-9]+)*\/[a-z0-9]+(-[a-z0-9]+)*$/,
  parserVersion: AMAZON_NEWS_PARSER_VERSION,
};

// Identifies the feed the offline parser is written for. Nothing in this
// repository requests it (see AMAZON_NEWS_LIVE_COLLECTION_STATUS).
export const AMAZON_NEWS_FEED_URL = "https://www.aboutamazon.jp/rss/feed.rss";

// Conservative v1: only titles that clearly announce a sale. Other news is
// not a candidate at all.
const SALE_TITLE = /セール|プライムデー|ブラックフライデー/u;

// One raw item per feed item (shared feed parser).
export const amazonNewsParser: Parser = feedItemParser;

export const amazonNewsNormalizer: Normalizer = {
  normalize(item) {
    if (!SALE_TITLE.test(item.title.normalize("NFKC"))) return null;
    const period = extractSaleDateRange([item.title, item.description]);
    return feedCandidate(item, period.ok ? { ...period.range, isDateOnly: false } : null);
  },
};

export const amazonNewsAdapter: SourceAdapter = {
  source: AMAZON_NEWS_SOURCE,
  documentUrl: AMAZON_NEWS_FEED_URL,
  parser: amazonNewsParser,
  normalizer: amazonNewsNormalizer,
};

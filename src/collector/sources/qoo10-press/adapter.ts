import type { Normalizer, Parser, SourceAdapter, SourceDescriptor } from "../../contract";
import { feedCandidate, feedItemParser } from "../../feed-candidate";
import { extractQoo10SaleDateRange } from "./date-range";

// Qoo10 large-sale announcements published by eBay Japan on PR TIMES, offline
// parts only: the feed is read from a document handed in by an injected
// Fetcher, so this module performs no network access. PR TIMES is a
// third-party platform, so the publisher is identified by the company id in
// the article URL (eBay Japan: 000022933), not by the host alone. That check
// is offline identity checking, not permission to collect.

// Live collection decision (Phase 5E-2): BLOCKED PENDING PERMISSION.
//
// The PR TIMES terms describe what general users may do with company content
// (viewing, obtaining information, private use, quotation) and restrict
// unauthorised commercial use and copying, modifying or reusing data. No
// official condition was found that expressly permits this app to retrieve
// eBay Japan's PR TIMES feed on a schedule, parse it, turn it into sale
// candidates and keep storing them. The feed being available is not treated
// as permission. This is a conservative product decision, not a legal
// conclusion: without confirmed permission, live collection stays off.
//
// Live collection may be reconsidered only when one of these is confirmed and
// recorded, never on a developer's judgment alone:
//   A. PR TIMES / eBay Japan expressly permit this specific use;
//   B. official terms clearly allow automated retrieval, parsing and
//      candidate generation / reuse for this purpose;
//   C. a formal (e.g. legal) review approves this specific use.
// Until then: no real Fetcher for this source, no schedule, and no database
// collection source for it. The offline parser stays. Manual Qoo10 sale
// registration on qoo10.jp is unaffected; allowing PR TIMES as a manual
// source would be a separate decision. live-source-gate.test.ts fails if any
// of this changes.
export const QOO10_PRESS_LIVE_COLLECTION_STATUS = "blocked_pending_permission";

export const QOO10_PRESS_PARSER_VERSION = "qoo10-ebay-japan-press-v1";

// eBay Japan's PR TIMES company id, as it appears in article URLs.
export const EBAY_JAPAN_PRTIMES_COMPANY_ID = "000022933";

export const QOO10_PRESS_SOURCE: SourceDescriptor = {
  sourceId: "qoo10-ebay-japan-press",
  retailerSlug: "qoo10",
  expectedHost: "prtimes.jp",
  // /main/html/rd/p/<release number>.<company id>.html, eBay Japan only.
  sourceUrlPattern: new RegExp(String.raw`^https://prtimes\.jp/main/html/rd/p/\d{9}\.${EBAY_JAPAN_PRTIMES_COMPANY_ID}\.html$`),
  parserVersion: QOO10_PRESS_PARSER_VERSION,
};

// Identifies the company feed (RSS 1.0) the offline parser is written for.
// Nothing in this repository requests it (see
// QOO10_PRESS_LIVE_COLLECTION_STATUS).
export const QOO10_PRESS_FEED_URL = "https://prtimes.jp/companyrdf.php?company_id=22933";

// Conservative v1: a Qoo10 title announcing a Mega sale (メガ割 / メガポ) being
// held. Commercials, visuals, reports, results, records and surveys mention
// the sale without announcing a new one, so they are not candidates even with
// those words. Everything else is ordinary news and is ignored.
const QOO10 = /qoo10/iu;
const MEGA_SALE = /メガ割|メガポ/u;
const ANNOUNCED = /開催/u;
const NOT_AN_ANNOUNCEMENT = /CM|コマーシャル|キービジュアル|動画|レポート|結果|過去最高|実績|開催しました|終了|調査|アンケート/u;

export function isQoo10MegaSaleAnnouncement(title: string): boolean {
  const text = title.normalize("NFKC");
  return QOO10.test(text) && MEGA_SALE.test(text) && ANNOUNCED.test(text) && !NOT_AN_ANNOUNCEMENT.test(text);
}

export const qoo10PressParser: Parser = feedItemParser;

export const qoo10PressNormalizer: Normalizer = {
  normalize(item) {
    if (!isQoo10MegaSaleAnnouncement(item.title)) return null;
    const period = extractQoo10SaleDateRange([item.title, item.description]);
    return feedCandidate(item, period.ok ? period.range : null);
  },
};

export const qoo10PressAdapter: SourceAdapter = {
  source: QOO10_PRESS_SOURCE,
  documentUrl: QOO10_PRESS_FEED_URL,
  parser: qoo10PressParser,
  normalizer: qoo10PressNormalizer,
};

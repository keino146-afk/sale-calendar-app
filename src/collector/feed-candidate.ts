import type { ParsedCandidate, Parser } from "./contract";
import { parseRssItems } from "./rss";
import { canonicalizeSourceUrl } from "./url";

// Shared building blocks for feed-based sources: one raw candidate per feed
// item, and the final candidate once a source has classified the item and
// read its period.

// Dates stay null here; each source's normalizer decides. The description is
// carried only so the normalizer can cross-check dates; it is never stored.
export const feedItemParser: Parser = {
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

export type ExtractedPeriod = { startsAt: Date; endsAt: Date; isDateOnly: boolean; text: string };

// Identity is the canonical article URL (no fragment or tracking
// parameters), not the GUID; an unusable link stays as given so the validator
// rejects it. Without a period the dates stay null and the validator rejects
// the candidate. The description is never kept; the evidence is plain text:
// the title, plus the period wording when it came from elsewhere.
export function feedCandidate(item: ParsedCandidate, period: ExtractedPeriod | null): ParsedCandidate {
  const url = canonicalizeSourceUrl(item.sourceUrl) ?? item.sourceUrl;
  const title = item.title.trim();
  return {
    externalKey: url,
    sourceUrl: url,
    title,
    description: null,
    startsAt: period?.startsAt ?? null,
    endsAt: period?.endsAt ?? null,
    isDateOnly: period?.isDateOnly ?? null,
    evidenceExcerpt: period !== null && !title.normalize("NFKC").includes(period.text) ? `${title}\n${period.text}` : title,
  };
}

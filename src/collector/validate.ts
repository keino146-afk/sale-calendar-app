import { computeContentHash } from "./content-hash";
import type { ParsedCandidate, SourceDescriptor, ValidatedCandidate } from "./contract";

// Generic safety checks before anything is submitted. They mirror the
// collection_candidates constraints and add sanity bounds so a misbehaving
// parser produces rejections rather than wrong candidates. Retailer-specific
// business rules belong to each adapter (later phases).

export const TITLE_MAX_LENGTH = 200;
export const DESCRIPTION_MAX_LENGTH = 5000;
export const EVIDENCE_MAX_LENGTH = 2000;
export const URL_MAX_LENGTH = 2048;
// Official large sales observed in Phase 5A run 4-13 days (Prime events,
// Rakuten SUPER SALE / marathons, Qoo10 Mega-wari). 31 days leaves ample room
// while still catching a parser that read the wrong year or month.
export const MAX_SALE_DURATION_DAYS = 31;
// Announcements come weeks ahead, not years.
export const MAX_DAYS_AHEAD = 400;
export const CHECKED_AT_FUTURE_TOLERANCE_MS = 10 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const PARSER_VERSION = /^[A-Za-z0-9._-]{1,40}$/;
const EXTERNAL_KEY = /^\S+$/;

export type ValidationIssue =
  | "external_key"
  | "source_url"
  | "title"
  | "description"
  | "evidence"
  | "missing_period"
  | "period_order"
  | "period_too_long"
  | "period_too_far"
  | "already_ended"
  | "date_only_not_midnight"
  | "checked_at"
  | "parser_version";

export type ValidationResult =
  | { ok: true; value: ValidatedCandidate }
  | { ok: false; issues: ValidationIssue[] };

function length(value: string): number {
  return [...value].length;
}

function isValidDate(value: Date | null): value is Date {
  return value instanceof Date && !Number.isNaN(value.getTime());
}

function isJstMidnight(value: Date): boolean {
  return (value.getTime() + JST_OFFSET_MS) % DAY_MS === 0;
}

export function isAllowedSourceUrl(raw: string, source: SourceDescriptor): boolean {
  if (raw.length > URL_MAX_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.hostname === source.expectedHost &&
    source.sourceUrlPattern.test(raw)
  );
}

export function validateCandidate(
  candidate: ParsedCandidate,
  context: { source: SourceDescriptor; checkedAt: Date; now: Date },
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const { source, checkedAt, now } = context;

  if (!EXTERNAL_KEY.test(candidate.externalKey) || candidate.externalKey.length > URL_MAX_LENGTH) {
    issues.push("external_key");
  }
  if (!isAllowedSourceUrl(candidate.sourceUrl, source)) issues.push("source_url");

  const strippedTitle = candidate.title.normalize("NFKC").replace(/\s+/gu, "");
  if (length(strippedTitle) < 1 || length(strippedTitle) > TITLE_MAX_LENGTH) issues.push("title");
  if (candidate.description !== null && length(candidate.description) > DESCRIPTION_MAX_LENGTH) {
    issues.push("description");
  }
  const evidenceLength = length(candidate.evidenceExcerpt);
  if (evidenceLength < 1 || evidenceLength > EVIDENCE_MAX_LENGTH) issues.push("evidence");

  const { startsAt, endsAt, isDateOnly } = candidate;
  if (!isValidDate(startsAt) || !isValidDate(endsAt) || isDateOnly === null) {
    issues.push("missing_period");
  } else {
    if (endsAt.getTime() <= startsAt.getTime()) issues.push("period_order");
    else if (endsAt.getTime() - startsAt.getTime() > MAX_SALE_DURATION_DAYS * DAY_MS) {
      issues.push("period_too_long");
    }
    if (startsAt.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) issues.push("period_too_far");
    if (endsAt.getTime() <= now.getTime()) issues.push("already_ended");
    if (isDateOnly && (!isJstMidnight(startsAt) || !isJstMidnight(endsAt))) {
      issues.push("date_only_not_midnight");
    }
  }

  if (!isValidDate(checkedAt) || checkedAt.getTime() > now.getTime() + CHECKED_AT_FUTURE_TOLERANCE_MS) {
    issues.push("checked_at");
  }
  if (!PARSER_VERSION.test(source.parserVersion)) issues.push("parser_version");

  if (issues.length > 0 || !isValidDate(startsAt) || !isValidDate(endsAt) || isDateOnly === null) {
    return { ok: false, issues };
  }

  const title = candidate.title.trim();
  const description = candidate.description?.trim() || null;
  return {
    ok: true,
    value: {
      externalKey: candidate.externalKey,
      sourceUrl: candidate.sourceUrl,
      title,
      description,
      startsAt,
      endsAt,
      isDateOnly,
      evidenceExcerpt: candidate.evidenceExcerpt,
      sourceCheckedAt: checkedAt,
      contentHash: computeContentHash({
        sourceUrl: candidate.sourceUrl,
        title,
        description,
        startsAt,
        endsAt,
        isDateOnly,
      }),
      parserVersion: source.parserVersion,
    },
  };
}

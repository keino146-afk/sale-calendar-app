// Collector contracts (Phase 5B foundation). A collector run is:
//   Fetcher -> Parser -> Normalizer -> Validator -> CandidateWriter
// Each retailer source is a separate SourceAdapter, so one source changing its
// markup cannot affect another. Nothing here knows about the public sales table or any
// sale lifecycle status: collectors only submit staging candidates, which an
// admin reviews and imports later.

export type SourceDescriptor = {
  sourceId: string;
  retailerSlug: string;
  // Exact host every candidate URL must use.
  expectedHost: string;
  // Anchored pattern every candidate URL must match (can pin a publisher).
  sourceUrlPattern: RegExp;
  parserVersion: string;
};

export type FetchedDocument = {
  url: string;
  status: number;
  contentType: string | null;
  body: string;
  fetchedAt: Date;
};

export interface Fetcher {
  fetch(url: string): Promise<FetchedDocument>;
}

// What a parser extracted. Dates stay null when the source does not state
// them; the validator rejects such candidates instead of guessing.
export type ParsedCandidate = {
  externalKey: string;
  sourceUrl: string;
  title: string;
  description: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  isDateOnly: boolean | null;
  evidenceExcerpt: string;
};

export interface Parser {
  parse(document: FetchedDocument): ParsedCandidate[];
}

export interface Normalizer {
  normalize(candidate: ParsedCandidate): ParsedCandidate;
}

export type ValidatedCandidate = Readonly<{
  externalKey: string;
  sourceUrl: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  isDateOnly: boolean;
  evidenceExcerpt: string;
  sourceCheckedAt: Date;
  contentHash: string;
  parserVersion: string;
}>;

export type CandidateWriteInput = ValidatedCandidate & Readonly<{ sourceId: string }>;

export type CandidateWriteOutcome = "inserted" | "seen" | "changed";

export interface CandidateWriter {
  submit(input: CandidateWriteInput): Promise<CandidateWriteOutcome>;
}

export type SourceAdapter = {
  source: SourceDescriptor;
  // The single document fetched per run (a feed or listing page).
  documentUrl: string;
  parser: Parser;
  normalizer: Normalizer;
};

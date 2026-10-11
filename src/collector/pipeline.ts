import type {
  CandidateWriteOutcome,
  CandidateWriter,
  Fetcher,
  SourceAdapter,
} from "./contract";
import { validateCandidate, type ValidationIssue } from "./validate";

// One collection run for one source. It only ever submits candidates through
// the writer; there is no delete or update path, so a failed or empty run can
// never remove anything. Zero parsed items is reported as a parser failure,
// never as "the sale is gone".

export type RunFailure = "fetch_failed" | "http_error" | "parse_failed" | "empty_result";

export type RunSummary = {
  sourceId: string;
  parserVersion: string;
  httpStatus: number | null;
  failure: RunFailure | null;
  discovered: number;
  inserted: number;
  seen: number;
  changed: number;
  rejected: number;
  rejectedIssues: Partial<Record<ValidationIssue, number>>;
  writeErrors: number;
};

export async function runCollection({
  adapter,
  fetcher,
  writer,
  now,
}: {
  adapter: SourceAdapter;
  fetcher: Fetcher;
  writer: CandidateWriter;
  now: () => Date;
}): Promise<RunSummary> {
  const summary: RunSummary = {
    sourceId: adapter.source.sourceId,
    parserVersion: adapter.source.parserVersion,
    httpStatus: null,
    failure: null,
    discovered: 0,
    inserted: 0,
    seen: 0,
    changed: 0,
    rejected: 0,
    rejectedIssues: {},
    writeErrors: 0,
  };

  let document;
  try {
    document = await fetcher.fetch(adapter.documentUrl);
  } catch {
    return { ...summary, failure: "fetch_failed" };
  }
  summary.httpStatus = document.status;
  if (document.status !== 200) return { ...summary, failure: "http_error" };

  let parsed;
  try {
    parsed = adapter.parser.parse(document);
  } catch {
    return { ...summary, failure: "parse_failed" };
  }
  if (parsed.length === 0) return { ...summary, failure: "empty_result" };
  summary.discovered = parsed.length;

  for (const item of parsed) {
    const result = validateCandidate(adapter.normalizer.normalize(item), {
      source: adapter.source,
      checkedAt: document.fetchedAt,
      now: now(),
    });
    if (!result.ok) {
      summary.rejected += 1;
      for (const issue of result.issues) {
        summary.rejectedIssues[issue] = (summary.rejectedIssues[issue] ?? 0) + 1;
      }
      continue;
    }
    let outcome: CandidateWriteOutcome;
    try {
      outcome = await writer.submit({ ...result.value, sourceId: adapter.source.sourceId });
    } catch {
      summary.writeErrors += 1;
      continue;
    }
    summary[outcome] += 1;
  }
  return summary;
}

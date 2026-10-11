import { createHash } from "node:crypto";

// SHA-256 over the candidate fields that matter for review. Any change in
// these fields produces a new hash, which the database records as a change.
export function computeContentHash(fields: {
  sourceUrl: string;
  title: string;
  description: string | null;
  startsAt: Date;
  endsAt: Date;
  isDateOnly: boolean;
}): string {
  const canonical = JSON.stringify([
    fields.sourceUrl,
    fields.title,
    fields.description,
    fields.startsAt.toISOString(),
    fields.endsAt.toISOString(),
    fields.isDateOnly,
  ]);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

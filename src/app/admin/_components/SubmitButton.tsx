"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";

// The second approved Client Component (admin-security.test.ts pins this):
// a submit button that is disabled and says 処理中… while its form's Server
// Action is pending, so a double click does not send the form again. UX only:
// a repeated request is still refused by the database (unique index,
// expected_updated_at, status-guarded RPCs), which is what keeps the data
// safe. No data, server code or storage here.

export const SUBMIT_PENDING_LABEL = "処理中…";

export function SubmitButton({ className, children }: { className: string; children: ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={className}>
      {pending ? SUBMIT_PENDING_LABEL : children}
    </button>
  );
}

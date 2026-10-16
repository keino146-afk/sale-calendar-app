// Shown beside the status of a pending or published sale whose period has
// already ended (see isSalePastEnd). Worded apart from the 終了 (archived)
// status so the two are not confused.
export function PastEndBadge() {
  return (
    <span data-past-end="true" className="rounded-md bg-orange-100 px-1.5 py-0.5 text-[11px] font-semibold text-orange-800">
      期間切れ
    </span>
  );
}

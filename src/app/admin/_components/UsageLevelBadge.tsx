import { P6_LEVEL_LABELS } from "@/lib/p6-usage-form";

// The P6 usage level of one metric, in words as well as colour.
const TONES: Record<number, string> = {
  0: "bg-slate-100 text-slate-700",
  60: "bg-sky-100 text-sky-900",
  80: "bg-amber-100 text-amber-900",
  90: "bg-orange-200 text-orange-950",
  95: "bg-red-600 text-white",
};

export function UsageLevelBadge({ level }: { level: number | null }) {
  const known = level !== null && Object.hasOwn(P6_LEVEL_LABELS, level);
  return (
    <span
      data-level={known ? level : "unknown"}
      className={`whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-semibold ${
        known ? TONES[level] : "bg-slate-200 text-slate-800"
      }`}
    >
      {known ? P6_LEVEL_LABELS[level] : "未取得（0%とは扱いません）"}
    </span>
  );
}

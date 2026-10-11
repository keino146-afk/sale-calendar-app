// Text-only retailer styling (no logos or brand images): a fixed soft tone
// per known retailer and a neutral fallback.
export type RetailerTone = {
  badge: string;
  bar: string;
};

const TONES: Record<string, RetailerTone> = {
  rakuten: { badge: "bg-rose-50 text-rose-700 ring-rose-200", bar: "bg-rose-200 text-rose-950" },
  amazon: { badge: "bg-amber-50 text-amber-800 ring-amber-200", bar: "bg-amber-200 text-amber-950" },
  qoo10: { badge: "bg-violet-50 text-violet-700 ring-violet-200", bar: "bg-violet-200 text-violet-950" },
};

const NEUTRAL: RetailerTone = {
  badge: "bg-slate-50 text-slate-700 ring-slate-200",
  bar: "bg-sky-200 text-sky-950",
};

export function retailerTone(slug: string): RetailerTone {
  return Object.hasOwn(TONES, slug) ? TONES[slug] : NEUTRAL;
}

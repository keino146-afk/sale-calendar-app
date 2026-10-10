// Text-only retailer styling (no logos or brand images): a fixed soft tone
// per known retailer and a neutral fallback.
export type RetailerTone = {
  badge: string;
  bar: string;
};

const TONES: Record<string, RetailerTone> = {
  rakuten: { badge: "bg-rose-50 text-rose-700 ring-rose-200", bar: "bg-rose-100 text-rose-800" },
  amazon: { badge: "bg-amber-50 text-amber-800 ring-amber-200", bar: "bg-amber-100 text-amber-900" },
  qoo10: { badge: "bg-violet-50 text-violet-700 ring-violet-200", bar: "bg-violet-100 text-violet-800" },
};

const NEUTRAL: RetailerTone = {
  badge: "bg-slate-50 text-slate-700 ring-slate-200",
  bar: "bg-sky-100 text-sky-900",
};

export function retailerTone(slug: string): RetailerTone {
  return Object.hasOwn(TONES, slug) ? TONES[slug] : NEUTRAL;
}

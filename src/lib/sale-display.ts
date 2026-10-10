import {
  addDays,
  formatJstMonthDayTime,
  formatJstMonthDayWeekday,
  startOfJstDay,
} from "./jst";

export const UPCOMING_DAYS = 14;

// Minimal shape needed for timing; endsAt is an exclusive boundary.
export type SaleTiming = {
  startsAt: string;
  endsAt: string;
  isDateOnly: boolean;
};

export function isSaleActive(sale: SaleTiming, now: Date): boolean {
  const nowMs = now.getTime();
  return new Date(sale.startsAt).getTime() <= nowMs && new Date(sale.endsAt).getTime() > nowMs;
}

export function isSaleUpcoming(sale: SaleTiming, now: Date, days: number): boolean {
  const startsMs = new Date(sale.startsAt).getTime();
  return now.getTime() < startsMs && startsMs < addDays(now, days).getTime();
}

export function classifySales<T extends SaleTiming>(
  sales: readonly T[],
  now: Date,
  days: number = UPCOMING_DAYS,
): { active: T[]; upcoming: T[] } {
  const active: T[] = [];
  const upcoming: T[] = [];
  for (const sale of sales) {
    if (isSaleActive(sale, now)) active.push(sale);
    else if (isSaleUpcoming(sale, now, days)) upcoming.push(sale);
  }
  return { active, upcoming };
}

// Date-only: the exclusive end (next day 00:00 JST) is shown as the last day.
// Timed: the stored exclusive end boundary is shown as-is (no -1 minute).
export function formatSalePeriod(sale: SaleTiming): string {
  const startsAt = new Date(sale.startsAt);
  const endsAt = new Date(sale.endsAt);

  if (sale.isDateOnly) {
    const first = formatJstMonthDayWeekday(startsAt);
    const last = formatJstMonthDayWeekday(addDays(startOfJstDay(endsAt), -1));
    return first === last ? first : `${first} 〜 ${last}`;
  }

  return `${formatJstMonthDayTime(startsAt)} 〜 ${formatJstMonthDayTime(endsAt)}`;
}

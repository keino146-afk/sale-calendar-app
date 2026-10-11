import Link from "next/link";
import { formatDayHeading, type CalendarWeek } from "@/lib/calendar-grid";
import { retailerTone } from "@/lib/retailer-tone";

export type MonthGridEvent = {
  id: string;
  title: string;
  retailerSlug: string;
  retailerName: string;
};

type MonthGridProps = {
  weeks: readonly CalendarWeek<MonthGridEvent>[];
  selectedKey: string;
  dayHref: (dayKey: string) => string;
};

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

function weekdayTextClass(weekday: number): string {
  if (weekday === 0) return "text-red-500";
  if (weekday === 6) return "text-blue-500";
  return "text-foreground/70";
}

// Each week is a compact 7-column grid: row 1 holds the day numbers (with a
// small "+n" overflow badge), rows 2-3 the sale bars (two lanes). Every day
// is a link that selects it; bars are decorative overlays that let taps fall
// through.
export function MonthGrid({ weeks, selectedKey, dayHref }: MonthGridProps) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="grid grid-cols-7 pb-0.5 text-center text-[11px] font-medium">
        {WEEKDAY_LABELS.map((label, weekday) => (
          <div key={label} className={weekdayTextClass(weekday)}>
            {label}
          </div>
        ))}
      </div>
      <ol className="flex flex-col divide-y divide-black/[0.04]">
        {weeks.map((week) => (
          <li
            key={week.days[0].key}
            data-week-start={week.days[0].key}
            className="relative grid grid-cols-7 grid-rows-[1.5rem_1rem_1rem] gap-y-px py-0.5"
          >
            {week.days.map((day, column) => {
              const count =
                week.segments.filter(
                  (segment) =>
                    segment.startColumn <= column && column < segment.startColumn + segment.span,
                ).length + week.hiddenCounts[column];
              const isSelected = day.key === selectedKey;
              const label = [
                formatDayHeading(day),
                count > 0 ? `セール${count}件` : "セールなし",
                day.isToday ? "今日" : null,
                isSelected ? "選択中" : null,
              ]
                .filter((part) => part !== null)
                .join("、");
              // Today keeps the filled blue circle; another selected day only
              // gets a pale circle around its number.
              const numberClass = day.isToday
                ? "bg-blue-500 font-semibold text-white"
                : `${day.inMonth ? weekdayTextClass(day.weekday) : "text-slate-300"} ${
                    isSelected ? "bg-blue-50 font-semibold ring-1 ring-blue-300" : ""
                  }`;
              return (
                <Link
                  key={day.key}
                  href={dayHref(day.key)}
                  scroll={false}
                  aria-label={label}
                  aria-current={day.isToday ? "date" : undefined}
                  data-date={day.key}
                  data-in-month={day.inMonth ? "true" : "false"}
                  data-selected={isSelected ? "true" : "false"}
                  style={{ gridColumn: column + 1, gridRow: "1 / -1" }}
                  className="flex justify-center"
                >
                  <span
                    className={`flex h-6 w-6 items-center justify-center rounded-full text-[13px] ${numberClass}`}
                  >
                    {day.day}
                  </span>
                </Link>
              );
            })}
            {week.segments.map((segment) => (
              <span
                key={`${segment.event.id}-${week.days[0].key}`}
                aria-hidden="true"
                data-sale-id={segment.event.id}
                data-start-column={segment.startColumn}
                data-span={segment.span}
                data-lane={segment.lane}
                style={{
                  gridColumn: `${segment.startColumn + 1} / span ${segment.span}`,
                  gridRow: segment.lane + 2,
                }}
                className={`pointer-events-none z-10 truncate px-1.5 text-[10px] font-semibold leading-4 ${
                  retailerTone(segment.event.retailerSlug).bar
                } ${segment.continuesBefore ? "rounded-l-none" : "ml-0.5 rounded-l-full"} ${
                  segment.continuesAfter ? "rounded-r-none" : "mr-0.5 rounded-r-full"
                }`}
              >
                {segment.event.title}
              </span>
            ))}
            {week.hiddenCounts.map((hidden, column) =>
              hidden > 0 ? (
                <span
                  key={`more-${week.days[column].key}`}
                  aria-hidden="true"
                  data-more-date={week.days[column].key}
                  style={{ gridColumn: column + 1, gridRow: 1 }}
                  className="pointer-events-none z-10 self-start justify-self-end pr-0.5 text-[9px] leading-3 text-foreground/60"
                >
                  +{hidden}
                </span>
              ) : null,
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

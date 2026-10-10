import Link from "next/link";
import { splitVisibleEvents, type CalendarCell } from "@/lib/calendar-grid";

export type MonthGridEvent = {
  id: string;
  title: string;
  retailerName: string;
};

type MonthGridProps = {
  cells: readonly CalendarCell<MonthGridEvent>[];
};

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"] as const;

function weekdayTextClass(weekday: number): string {
  if (weekday === 0) return "text-red-600";
  if (weekday === 6) return "text-blue-600";
  return "";
}

// Compact 6x7 grid: at most two events per day, the rest as "+n".
// The month list below the grid carries the full details on mobile.
export function MonthGrid({ cells }: MonthGridProps) {
  return (
    <div className="flex flex-col gap-1">
      <div className="grid grid-cols-7 text-center text-xs font-medium">
        {WEEKDAY_LABELS.map((label, weekday) => (
          <div key={label} className={weekdayTextClass(weekday)}>
            {label}
          </div>
        ))}
      </div>
      <ol className="grid grid-cols-7 gap-px overflow-hidden rounded border border-foreground/15 bg-foreground/15">
        {cells.map((cell) => {
          const { visible, hiddenCount } = splitVisibleEvents(cell.events);
          return (
            <li
              key={cell.key}
              data-date={cell.key}
              data-in-month={cell.inMonth ? "true" : "false"}
              aria-current={cell.isToday ? "date" : undefined}
              className={`flex min-h-16 min-w-0 flex-col gap-0.5 bg-background p-0.5 ${
                cell.inMonth ? "" : "opacity-40"
              }`}
            >
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-xs ${
                  cell.isToday ? "bg-foreground font-semibold text-background" : weekdayTextClass(cell.weekday)
                }`}
              >
                {cell.day}
              </span>
              {visible.map((event) => (
                <Link
                  key={event.id}
                  href={`/sales/${event.id}`}
                  title={`${event.retailerName} ${event.title}`}
                  className="truncate rounded bg-red-600/10 px-0.5 text-[10px] leading-tight"
                >
                  {event.title}
                </Link>
              ))}
              {hiddenCount > 0 ? (
                <span className="text-[10px] leading-tight text-foreground/70">+{hiddenCount}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </div>
  );
}

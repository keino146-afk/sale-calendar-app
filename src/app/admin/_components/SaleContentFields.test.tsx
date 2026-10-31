import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseJstDateTime } from "@/lib/sale-candidate-form";
import { formatPublicSalePeriod } from "@/lib/sale-display";
import { END_DATETIME_HELP, SaleContentFields } from "./SaleContentFields";

// Rendered to static markup, as the admin pages are sent by the server.

function render(mode: "date" | "datetime") {
  return renderToStaticMarkup(
    <SaleContentFields
      mode={mode}
      defaults={null}
      checkedAtDefault="2026-11-01T10:00"
      modeHref={(m) => `/admin/new?mode=${m}`}
    />,
  );
}

describe("SaleContentFields end field", () => {
  it("explains under the timed end that the entered time is not part of the sale, with the 1:59 -> 2:00 example", () => {
    const html = render("datetime");

    expect(html).not.toContain("この時刻に終了");
    expect(html).toContain(END_DATETIME_HELP);
    expect(END_DATETIME_HELP).toBe(
      "入力した時刻はセールの開催期間に含まれません。例：公式案内が「11/15 1:59まで」の場合は「11/15 2:00」を入力してください。",
    );
    // The help sits in the end field's label, next to its input.
    expect(html).toMatch(/終了日時（日本時間）<input type="datetime-local"[^>]*name="endsAt"[^>]*><span[^>]*>入力した時刻は/);
    // The start field gets no such help.
    expect(html).toMatch(/開始日時（日本時間）<input type="datetime-local"[^>]*name="startsAt"[^>]*><\/label>/);
  });

  it("keeps the date-only end field as it was, without the timed help", () => {
    const html = render("date");

    expect(html).toMatch(/終了日（この日を含む）<input type="date"[^>]*name="endDate"[^>]*><\/label>/);
    expect(html).not.toContain(END_DATETIME_HELP);
  });

  it("matches what is stored and shown: entering 2:00 is shown publicly as the last minute 1:59", () => {
    const startsAt = parseJstDateTime("2026-11-14T20:00");
    const endsAt = parseJstDateTime("2026-11-15T02:00");

    // Stored as entered, as the exclusive end (no minute added or removed).
    expect(endsAt?.toISOString()).toBe("2026-11-14T17:00:00.000Z");
    expect(
      formatPublicSalePeriod({ startsAt: startsAt!.toISOString(), endsAt: endsAt!.toISOString(), isDateOnly: false }),
    ).toBe("11/14 20:00 〜 11/15 01:59");
  });
});

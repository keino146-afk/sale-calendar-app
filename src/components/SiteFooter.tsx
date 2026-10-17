// Footer of the public pages (home, calendar, sale detail, 404). Not in the
// root layout, so the admin area never shows it. Fixed text only: no contact
// details, no data access.

export const SITE_DISCLAIMER = [
  "掲載情報は確認時点のものです。",
  "セールの開催期間・内容は変更される場合があります。",
  "最新情報は各公式サイトをご確認ください。",
] as const;

export const SITE_OPERATOR = "運営：セールカレンダー運営";

export function SiteFooter() {
  return (
    <footer className="mx-auto flex w-full max-w-md flex-col gap-2 px-4 pb-8 pt-2 text-xs leading-relaxed text-foreground/60">
      <p>
        {SITE_DISCLAIMER.map((sentence) => (
          <span key={sentence} className="block">
            {sentence}
          </span>
        ))}
      </p>
      <p>{SITE_OPERATOR}</p>
    </footer>
  );
}

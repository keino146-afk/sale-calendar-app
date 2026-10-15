import type { ReactNode } from "react";
import Link from "next/link";
import {
  DESCRIPTION_MAX_LENGTH,
  SOURCE_URL_MAX_LENGTH,
  type PeriodMode,
  type SaleFormDefaults,
} from "@/lib/sale-candidate-form";

// The sale content fields shared by registration (/admin/new) and editing
// (/admin/sales/[saleId]/edit), in the same order and with the same names,
// so both submissions go through parseSaleContentForm.

export const INPUT_CLASS = "rounded-xl border border-black/10 px-3 py-2 text-base";

export function Field({ label, help, children }: { label: string; help?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {children}
      {help !== undefined ? <span className="text-xs text-foreground/60">{help}</span> : null}
    </label>
  );
}

function ModeLink({
  href,
  selected,
  children,
}: {
  href: string;
  selected: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      aria-current={selected ? "page" : undefined}
      className={`flex-1 rounded-full px-4 py-1.5 text-center text-sm ${
        selected ? "bg-blue-500 font-semibold text-white" : "border border-black/10 bg-white"
      }`}
    >
      {children}
    </Link>
  );
}

export function SaleContentFields({
  mode,
  defaults,
  checkedAtDefault,
  modeHref,
}: {
  mode: PeriodMode;
  defaults: Omit<SaleFormDefaults, "retailerId"> | null;
  checkedAtDefault: string;
  modeHref: (mode: PeriodMode) => string;
}) {
  return (
    <>
      <Field label="タイトル">
        <input type="text" name="title" required maxLength={400} defaultValue={defaults?.title} className={INPUT_CLASS} />
      </Field>
      <Field label="説明（任意）">
        <textarea
          name="description"
          rows={3}
          maxLength={DESCRIPTION_MAX_LENGTH}
          defaultValue={defaults?.description}
          className={INPUT_CLASS}
        />
      </Field>
      <nav aria-label="期間の種類" className="flex gap-2">
        <ModeLink href={modeHref("date")} selected={mode === "date"}>
          日付のみ
        </ModeLink>
        <ModeLink href={modeHref("datetime")} selected={mode === "datetime"}>
          時刻あり
        </ModeLink>
      </nav>
      {mode === "date" ? (
        <>
          <Field label="開始日">
            <input type="date" name="startDate" required defaultValue={defaults?.startDate} className={INPUT_CLASS} />
          </Field>
          <Field label="終了日（この日を含む）">
            <input type="date" name="endDate" required defaultValue={defaults?.endDate} className={INPUT_CLASS} />
          </Field>
        </>
      ) : (
        <>
          <Field label="開始日時（日本時間）">
            <input type="datetime-local" name="startsAt" required defaultValue={defaults?.startsAt} className={INPUT_CLASS} />
          </Field>
          <Field label="終了日時（日本時間・この時刻に終了）">
            <input type="datetime-local" name="endsAt" required defaultValue={defaults?.endsAt} className={INPUT_CLASS} />
          </Field>
        </>
      )}
      <Field label="公式ページURL" help="セール情報を確認した公式ページを入力してください">
        <input
          type="url"
          name="sourceUrl"
          required
          maxLength={SOURCE_URL_MAX_LENGTH}
          placeholder="https://"
          defaultValue={defaults?.sourceUrl}
          className={INPUT_CLASS}
        />
      </Field>
      <Field label="情報を確認した日時（日本時間）">
        <input
          type="datetime-local"
          name="sourceCheckedAt"
          required
          defaultValue={defaults?.sourceCheckedAt ?? checkedAtDefault}
          className={INPUT_CLASS}
        />
      </Field>
    </>
  );
}

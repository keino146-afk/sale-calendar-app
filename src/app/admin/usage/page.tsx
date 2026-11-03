import type { ReactNode } from "react";
import Link from "next/link";
import { connection } from "next/server";
import {
  commitUsageAction,
  discardDraftAction,
  failureAction,
  previewUsageAction,
  resumeAction,
  stopAction,
  voidAction,
} from "./actions";
import { p6DraftDigest, readP6Draft } from "./draft-cookie";
import { Field, INPUT_CLASS } from "../_components/SaleContentFields";
import { SubmitButton } from "../_components/SubmitButton";
import { UsageLevelBadge } from "../_components/UsageLevelBadge";
import { requireAdmin } from "@/server/auth/admin-session";
import {
  getP6Status,
  previewP6UsageCheck,
  type P6Preview,
  type P6State,
  type P6Status,
  type P6Value,
} from "@/server/data/admin-usage-monitoring";
import { formatJstDateTime } from "@/lib/jst";
import {
  P6_BYTE_UNITS,
  P6_FAILURE_KIND_LABELS,
  P6_INVALID_REASON_LABELS,
  P6_METRICS,
  P6_RESUME_REFUSAL_LABELS,
  P6_SPEND_CAP_LABELS,
  P6_STOP_REASON_CHOICES,
  P6_STOP_REASON_LABELS,
  P6_VOID_REASON_LABELS,
  parseP6UsageForm,
  type P6MetricDefinition,
  type P6RawForm,
} from "@/lib/p6-usage-form";
import { toJstDateTimeLocal } from "@/lib/sale-candidate-form";

// P6 usage monitoring (/admin/usage). The admin records what the official
// Supabase dashboard shows; the database decides what would be allowed.
// Mobile first (one column, 16px inputs, decimal keyboards). Entered numbers
// travel only in POST bodies and an HttpOnly cookie, never in URLs. Only
// fixed codes are read from the query string.

const ERROR_MESSAGES: Record<string, string> = {
  checked_at: "公式画面を確認した時刻を正しく入力してください",
  period: "請求期間の開始日と終了日を正しく入力してください",
  spend_cap: "Spend Cap の状態を選んでください",
  data_as_of: "データの対象時刻を正しく入力するか、空欄にしてください",
  value: "「数値を確認できた」を選んだ項目には、使用量と上限を正しく入力してください",
  status: "すべての項目で「数値を確認できた」か「取得できなかった」を選んでください",
  status_value: "「取得できなかった」を選んだ項目には、使用量と上限を入力しないでください（空欄にしてください）",
  confirm_required: "確認のチェックを入れてから操作してください",
  stale: "画面を開いた後に記録が変わりました。最新の内容を確認してから、もう一度操作してください",
  duplicate: "同じ確認時刻の記録がすでにあります",
  invalid_input: "入力内容を確認してください",
  not_found: "対象の記録が見つからないか、すでに無効になっています",
  draft_missing: "確認中の入力が見つかりませんでした。もう一度入力してください",
  draft_too_large: "入力内容が長すぎるため保存できませんでした（以前の入力も破棄しました）。各項目に数値だけを入力し、もう一度確認してください",
  draft_changed: "確認した後に入力内容が変わりました（別の画面で入力し直した可能性があります）。保存していません。表示中の内容を確認し直してください",
  resume_refused: "再開の条件を満たしていません",
  failed: "処理できませんでした",
};

const DONE_MESSAGES: Record<string, string> = {
  recorded: "有効な確認として記録しました",
  recorded_invalid: "無効な確認として記録しました（監視障害として扱われます）",
  discarded: "入力を破棄しました",
  failure_recorded: "監視障害を記録しました",
  stopped: "手動で停止しました",
  resumed_registration: "新規登録を再開しました",
  resumed_send: "既存Pushの送信を再開しました",
  voided: "記録を無効にしました（停止は解除されません）",
};

const METRIC_BY_CODE = new Map(P6_METRICS.map((metric) => [metric.code, metric]));

function pick(map: Record<string, string>, value: string | string[] | undefined): string | null {
  return typeof value === "string" && Object.hasOwn(map, value) ? map[value] : null;
}

function jst(iso: string | null): string {
  return iso === null ? "—" : `${formatJstDateTime(new Date(iso))}（日本時間）`;
}

// "0.50000" -> "0.5"; "2000000" -> "2,000,000".
function formatNumber(text: string | null): string {
  if (text === null) return "—";
  const [whole, fraction] = text.split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const trimmed = fraction?.replace(/0+$/, "") ?? "";
  return trimmed === "" ? grouped : `${grouped}.${trimmed}`;
}

function usageText(metric: P6MetricDefinition | undefined, usage: string | null): string {
  return metric?.unitKind === "count" ? formatNumber(usage) : `${formatNumber(usage)} GB`;
}

export default async function AdminUsagePage({ searchParams }: PageProps<"/admin/usage">) {
  // connection() and requireAdmin() work by throwing and stay outside
  // try/catch. Nothing is read before the guard.
  await connection();
  const supabase = await requireAdmin();
  const params = await searchParams;
  const errorMessage = pick(ERROR_MESSAGES, params.error);
  const refusalMessage = params.error === "resume_refused" ? pick(P6_RESUME_REFUSAL_LABELS, params.refusal) : null;
  const doneMessage = pick(DONE_MESSAGES, params.done);
  const now = new Date();

  let status: P6Status | null;
  try {
    status = await getP6Status(supabase);
  } catch (error) {
    console.error(`[admin] usage status failed: ${error instanceof Error ? error.name : "UnknownError"}`);
    status = null;
  }

  const draft = await readP6Draft();
  let preview: P6Preview | null = null;
  if (params.step === "confirm" && draft !== null) {
    const parsed = parseP6UsageForm(draft);
    if (parsed.ok) {
      const result = await previewP6UsageCheck(supabase, parsed.value);
      if (result.ok) preview = result.preview;
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-6">
      <Link href="/admin" className="w-fit text-sm text-blue-600">
        ‹ 管理画面へ戻る
      </Link>
      <h1 className="text-xl font-bold">使用量の監視（Supabase）</h1>
      <p data-not-connected="true" className="rounded-2xl bg-slate-100 px-4 py-3 text-sm text-slate-800">
        この画面の判定は、まだ実際の新規登録の受付・Push の配信には接続されていません（受付は閉じたままです）。
      </p>
      {doneMessage !== null ? (
        <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-center text-sm text-emerald-800">
          {doneMessage}
        </p>
      ) : null}
      {errorMessage !== null ? (
        <p role="alert" className="rounded-2xl bg-red-50 px-4 py-3 text-center text-sm text-red-700">
          {errorMessage}
          {refusalMessage !== null ? `：${refusalMessage}` : null}
        </p>
      ) : null}

      {status === null ? (
        <p className="rounded-2xl bg-white px-4 py-6 text-center text-sm shadow-sm">使用量の状態を読み込めませんでした</p>
      ) : (
        <>
          <StateSection state={status.state} />
          <LatestValues status={status} />
          <Warnings status={status} />
        </>
      )}

      {preview !== null && draft !== null ? (
        <ConfirmSection preview={preview} draft={draft} newPeriod={firstCheckOfPeriod(status, draft.periodStart)} />
      ) : (
        <InputForm draft={draft} now={now} />
      )}

      {status !== null ? (
        <>
          <FailureForm />
          <StopForm />
          <ResumeForms status={status} />
          <History status={status} />
        </>
      ) : null}
    </main>
  );
}

function Card({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <section id={id} aria-label={title} className="flex flex-col gap-3 rounded-2xl bg-white p-4 shadow-sm ring-1 ring-black/5">
      <h2 className="text-base font-bold">{title}</h2>
      {children}
    </section>
  );
}

function StateRow({ label, tone, text }: { label: string; tone: "ok" | "grace" | "stop"; text: string }) {
  const tones = { ok: "bg-emerald-100 text-emerald-900", grace: "bg-amber-100 text-amber-900", stop: "bg-red-100 text-red-800" };
  const words = { ok: "許可", grace: "猶予中", stop: "停止中" };
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{label}</span>
        <span data-state={tone} className={`rounded-md px-2 py-0.5 text-xs font-semibold ${tones[tone]}`}>
          {words[tone]}
        </span>
      </div>
      <span className="text-xs text-foreground/70">{text}</span>
    </div>
  );
}

function reason(code: string | null): string {
  return code !== null && Object.hasOwn(P6_STOP_REASON_LABELS, code) ? P6_STOP_REASON_LABELS[code] : "停止中";
}

function StateSection({ state }: { state: P6State }) {
  const registrationOwnStop =
    state.registrationStopAt === null || Date.parse(state.registrationStopAt) <= Date.parse(state.evaluatedAt);
  const sendText = state.sendsAllowed
    ? state.sendInGrace
      ? `監視が不完全なため、${jst(state.sendGraceUntil)} まで（最長1時間）の猶予中です。猶予は延長されません。`
      : `送信の期限：${jst(state.sendDeadline)}`
    : `理由：${reason(state.sendStopReason)}`;
  const registrationText = state.registrationAllowed
    ? `新規登録の期限：${jst(state.registrationDeadline)}`
    : registrationOwnStop
      ? `理由：${reason(state.registrationStopReason)}`
      : state.sendInGrace
        ? "理由：監視が不完全です"
        : "理由：既存Pushの送信が停止中です";
  const tokenText = state.tokenChangeAllowed
    ? "95%未満で、監視と送信の安全条件を満たしています"
    : state.sendInGrace
      ? "理由：監視が不完全です"
      : `理由：${reason(state.sendStopReason)}`;
  return (
    <Card id="state" title="現在の判定">
      <StateRow label="新規登録" tone={state.registrationAllowed ? "ok" : "stop"} text={registrationText} />
      <StateRow label="Token変更の確認" tone={state.tokenChangeAllowed ? "ok" : "stop"} text={tokenText} />
      <StateRow
        label="既存Pushの送信"
        tone={!state.sendsAllowed ? "stop" : state.sendInGrace ? "grace" : "ok"}
        text={sendText}
      />
      {state.manualStopActive ? (
        <p data-manual-stop="true" className="rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">
          手動停止中です。再開には、停止後に24時間以上空けた2回の正常な確認と、再開の操作が必要です。
        </p>
      ) : null}
      <p className="text-[11px] text-foreground/60">判定時刻（データベースの時刻）：{jst(state.evaluatedAt)}</p>
    </Card>
  );
}

function LatestValues({ status }: { status: P6Status }) {
  const latest = status.checks.find((check) => check.id === status.state.currentCheckId) ?? null;
  return (
    <Card id="latest" title="最新の有効な確認">
      {latest === null ? (
        <p className="text-sm text-foreground/70">有効な確認はまだありません</p>
      ) : (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-foreground/60">公式画面の確認時刻</dt>
            <dd>{jst(latest.checkedAt)}</dd>
            <dt className="text-foreground/60">管理画面への登録時刻</dt>
            <dd>{jst(latest.recordedAt)}</dd>
            <dt className="text-foreground/60">データの対象時刻</dt>
            <dd>{latest.dataAsOf === null ? "表示なし" : jst(latest.dataAsOf)}</dd>
            <dt className="text-foreground/60">請求期間</dt>
            <dd>
              {latest.periodStart} 〜 {latest.periodEnd}
            </dd>
          </dl>
          <ValueList values={latest.values} />
        </>
      )}
    </Card>
  );
}

function ValueList({ values }: { values: P6Value[] }) {
  return (
    <ul className="flex flex-col divide-y divide-black/5">
      {values.map((value) => {
        const metric = METRIC_BY_CODE.get(value.metric);
        return (
          <li key={value.metric} data-metric={value.metric} className="flex flex-col gap-1 py-2">
            <span className="flex flex-wrap items-center gap-1.5 text-sm font-semibold">
              {metric?.label ?? value.metric}
              <span className="rounded bg-slate-100 px-1 text-[10px] font-normal text-slate-700">{metric?.scopeLabel}</span>
            </span>
            {value.status === "unavailable" ? (
              <UsageLevelBadge level={null} />
            ) : (
              <span className="flex flex-wrap items-center gap-2 text-xs">
                <span>
                  使用量 {usageText(metric, value.usage)} ／ 上限 {metric?.quotaLabel}
                </span>
                <span className="font-semibold">{value.percent === null ? "—" : `${value.percent}%`}</span>
                <UsageLevelBadge level={value.level} />
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Warnings({ status }: { status: P6Status }) {
  const warnings = status.warnings.slice(0, 10);
  return (
    <Card id="warnings" title="警告の履歴">
      {warnings.length === 0 ? (
        <p className="text-sm text-foreground/70">警告はありません</p>
      ) : (
        <ul className="flex flex-col gap-1.5 text-xs">
          {warnings.map((warning) => (
            <li key={warning.id} data-warning={warning.kind} className="flex flex-wrap items-center gap-1.5">
              {warning.kind === "usage" ? (
                <>
                  <UsageLevelBadge level={warning.level} />
                  <span>{METRIC_BY_CODE.get(warning.metric ?? "")?.label ?? warning.metric}</span>
                </>
              ) : (
                <span className="rounded-md bg-red-100 px-1.5 py-0.5 font-semibold text-red-800">監視障害</span>
              )}
              <span className="text-foreground/60">{jst(warning.createdAt)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function MetricFields({ metric, draft }: { metric: P6MetricDefinition; draft: P6RawForm | null }) {
  const bytes = metric.unitKind === "bytes";
  const keyboard = bytes ? "decimal" : "numeric";
  return (
    <fieldset data-metric-input={metric.code} className="flex flex-col gap-2 rounded-xl border border-black/10 p-3">
      <legend className="px-1 text-sm font-semibold">{metric.label}</legend>
      <p className="text-xs text-foreground/70">
        {metric.scopeLabel}・{metric.kindLabel}・Pro の上限 {metric.quotaLabel}
      </p>
      {metric.note !== undefined ? <p className="text-xs text-amber-800">{metric.note}</p> : null}
      <div className="flex items-end gap-2">
        <label className="flex min-w-0 flex-1 flex-col gap-1 text-xs">
          使用量
          <input
            type="text"
            inputMode={keyboard}
            autoComplete="off"
            name={`${metric.code}.value`}
            defaultValue={draft?.[`${metric.code}.value`]}
            className={`${INPUT_CLASS} w-full`}
          />
        </label>
        {bytes ? (
          <label className="flex flex-col gap-1 text-xs">
            単位
            <select
              name={`${metric.code}.unit`}
              defaultValue={draft?.[`${metric.code}.unit`] ?? "GB"}
              className={INPUT_CLASS}
            >
              {P6_BYTE_UNITS.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <label className="flex flex-col gap-1 text-xs">
        画面に表示された上限{bytes ? "（GB）" : ""}
        <input
          type="text"
          inputMode={keyboard}
          autoComplete="off"
          name={`${metric.code}.quota`}
          defaultValue={draft?.[`${metric.code}.quota`]}
          className={INPUT_CLASS}
        />
      </label>
      <div role="radiogroup" aria-label={`${metric.label}：公式画面で数値を確認できたか`} className="flex flex-col gap-1 text-xs">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${metric.code}.status`}
            value="measured"
            required
            defaultChecked={draft?.[`${metric.code}.status`] === "measured"}
          />
          数値を確認できた（0 と表示されていれば 0 を入力）
        </label>
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${metric.code}.status`}
            value="unavailable"
            defaultChecked={draft?.[`${metric.code}.status`] === "unavailable"}
          />
          取得できなかった（使用量と上限は空欄。0%とは扱わず、監視障害になります）
        </label>
      </div>
    </fieldset>
  );
}

// How to choose between a normal 0 and "取得できなかった".
function ValueStatusGuide() {
  return (
    <div data-value-status-guide="true" className="flex flex-col gap-1 rounded-xl bg-slate-100 px-3 py-2 text-xs text-slate-800">
      <p className="font-semibold">項目ごとに、どちらかを必ず選んでください</p>
      <p>数値を確認できた：公式画面に数値が表示されている。0 と表示されていれば、正常な 0 として入力します。</p>
      <p>取得できなかった：数値が表示されない、読み込みに失敗した、No data しか確認できない。</p>
      <p>
        例：Storage Size で「Average in period: 0.00 GB」と、グラフの「No data in period」が並んでいる場合、グラフの No data だけで
        集計欄の 0.00 GB が誤りとは言えません。ただし 0.00 GB は、元のデータが新しいことの保証ではありません。
      </p>
      <p className="font-semibold">判断できないときは「取得できなかった」を選んでください（安全側です）。</p>
    </div>
  );
}

function InputForm({ draft, now }: { draft: P6RawForm | null; now: Date }) {
  const organization = P6_METRICS.filter((metric) => metric.scope === "organization");
  const projects = P6_METRICS.filter((metric) => metric.scope === "project");
  return (
    <Card id="input" title="公式画面の確認を記録する">
      <form action={previewUsageAction} className="flex flex-col gap-4">
        <Field
          label="公式画面を確認した時刻（日本時間）"
          help="Supabase の公式 Dashboard を開いて確認した時刻です。登録時刻は保存したときにデータベースが記録します。確認から1時間以内に保存してください。"
        >
          <input
            type="datetime-local"
            name="checkedAt"
            required
            defaultValue={draft?.checkedAt ?? toJstDateTimeLocal(now)}
            className={INPUT_CLASS}
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="請求期間の開始日">
            <input type="date" name="periodStart" required defaultValue={draft?.periodStart} className={`${INPUT_CLASS} w-full`} />
          </Field>
          <Field label="請求期間の終了日">
            <input type="date" name="periodEnd" required defaultValue={draft?.periodEnd} className={`${INPUT_CLASS} w-full`} />
          </Field>
        </div>
        <Field label="Spend Cap">
          <select name="spendCap" required defaultValue={draft?.spendCap ?? ""} className={INPUT_CLASS}>
            <option value="" disabled>
              選んでください
            </option>
            {Object.entries(P6_SPEND_CAP_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field
          label="データの対象時刻（日本時間・画面に表示がある場合だけ）"
          help="公式画面に対象時刻が表示されている場合だけ入力します。表示されていない場合は空欄にし、推測で入力しないでください。確認時刻より24時間以上前の時刻は、古すぎるため無効な確認になります。"
        >
          <input type="datetime-local" name="dataAsOf" defaultValue={draft?.dataAsOf} className={INPUT_CLASS} />
        </Field>
        <ValueStatusGuide />
        <h3 className="text-sm font-bold">組織全体の使用量（Organization）</h3>
        {organization.map((metric) => (
          <MetricFields key={metric.code} metric={metric} draft={draft} />
        ))}
        <h3 className="text-sm font-bold">プロジェクトごとの Disk（合計しません）</h3>
        {projects.map((metric) => (
          <MetricFields key={metric.code} metric={metric} draft={draft} />
        ))}
        <SubmitButton className="rounded-xl bg-blue-500 px-4 py-2.5 text-[15px] font-semibold text-white">
          入力内容を確認する（まだ保存しません）
        </SubmitButton>
      </form>
    </Card>
  );
}

// "first" when the newest valid (not voided) check on record is for another
// billing period; "unknown" when there is none, or the history could not be
// loaded (then the notice is shown too, without guessing the period).
function firstCheckOfPeriod(status: P6Status | null, periodStart: string | undefined): "first" | "unknown" | null {
  if (status === null) return "unknown";
  const latestValid = status.checks
    .filter((check) => check.isValid && check.voidedAt === null)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))[0];
  if (latestValid === undefined) return "unknown";
  return latestValid.periodStart === periodStart ? null : "first";
}

function ConfirmSection({
  preview,
  draft,
  newPeriod,
}: {
  preview: P6Preview;
  draft: P6RawForm;
  newPeriod: "first" | "unknown" | null;
}) {
  const zeroMetrics = preview.values.filter(
    (value) => value.status === "measured" && value.usage !== null && Number(value.usage) === 0,
  );
  return (
    <Card id="confirm" title="入力内容の確認（まだ保存されていません）">
      {zeroMetrics.length > 0 ? (
        <div data-zero-notice="true" className="flex flex-col gap-1 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p>
            次の項目は 0 として保存されます：
            {zeroMetrics.map((value) => METRIC_BY_CODE.get(value.metric)?.label ?? value.metric).join("、")}
          </p>
          <p className="text-xs">
            公式画面に数値の 0 が表示されていた場合だけ、そのまま保存してください。No data しか確認できなかった・読み込めなかった場合は、入力に戻って「取得できなかった」を選んでください。
          </p>
        </div>
      ) : null}
      {newPeriod !== null ? (
        <div data-new-period-notice={newPeriod} className="flex flex-col gap-1 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <p>
            {newPeriod === "first"
              ? "この請求期間で最初の確認です。"
              : "前回の有効な確認がない（または読み込めない）ため、新しい請求期間の最初の確認として注意してください。"}
          </p>
          <p className="text-xs">
            請求期間が切り替わった直後は、公式画面の数値がまだ反映されていないことがあります。No data や表示されない項目は「取得できなかった」を選んでください。
          </p>
        </div>
      ) : null}
      {preview.valid ? (
        <p data-preview-valid="true" className="rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
          有効な確認として記録されます。
        </p>
      ) : (
        <div data-preview-valid="false" className="flex flex-col gap-1 rounded-xl bg-red-50 px-3 py-2 text-sm text-red-800">
          <p>
            無効な確認として記録されます。監視障害として扱われ、新規登録はすぐに停止し、既存Pushの送信は最長1時間で停止します。
          </p>
          <ul className="list-disc pl-5 text-xs">
            {preview.reasons.map((code) => (
              <li key={code}>{P6_INVALID_REASON_LABELS[code] ?? code}</li>
            ))}
          </ul>
        </div>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-foreground/60">公式画面の確認時刻</dt>
        <dd>{draft.checkedAt?.replace("T", " ")}（日本時間）</dd>
        <dt className="text-foreground/60">管理画面への登録時刻</dt>
        <dd>保存したときにデータベースが記録します</dd>
        <dt className="text-foreground/60">データの対象時刻</dt>
        <dd>{draft.dataAsOf ? `${draft.dataAsOf.replace("T", " ")}（日本時間）` : "表示なし"}</dd>
        <dt className="text-foreground/60">請求期間</dt>
        <dd>
          {draft.periodStart} 〜 {draft.periodEnd}
        </dd>
        <dt className="text-foreground/60">Spend Cap</dt>
        <dd>{P6_SPEND_CAP_LABELS[draft.spendCap as keyof typeof P6_SPEND_CAP_LABELS] ?? "—"}</dd>
      </dl>
      <ul className="flex flex-col divide-y divide-black/5">
        {preview.values.map((value) => {
          const metric = METRIC_BY_CODE.get(value.metric);
          return (
            <li key={value.metric} data-preview-metric={value.metric} className="flex flex-col gap-1 py-2 text-xs">
              <span className="text-sm font-semibold">{metric?.label ?? value.metric}</span>
              {value.status === "unavailable" ? (
                <UsageLevelBadge level={null} />
              ) : (
                <>
                  <span>
                    入力：{formatNumber(value.enteredValue)} {value.enteredUnit === "count" ? "" : value.enteredUnit}
                    {metric?.unitKind === "bytes" ? ` → ${usageText(metric, value.usage)}` : ""}
                  </span>
                  <span>
                    上限：入力 {formatNumber(value.enteredQuota)} ／ Pro {metric?.quotaLabel}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-semibold">使用率 {value.percent === null ? "—" : `${value.percent}%`}</span>
                    <UsageLevelBadge level={value.level} />
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      <form action={commitUsageAction} className="flex flex-col gap-3">
        <input type="hidden" name="expectedVersion" value={preview.version} />
        <input type="hidden" name="expectedValid" value={String(preview.valid)} />
        <input type="hidden" name="draftDigest" value={p6DraftDigest(draft)} />
        <label className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          <input type="checkbox" name="confirmed" value="on" required className="mt-1" />
          公式画面の表示と同じ内容であることを確認しました
        </label>
        <SubmitButton className="rounded-xl bg-blue-500 px-4 py-2.5 text-[15px] font-semibold text-white">
          この内容で記録する
        </SubmitButton>
      </form>
      <Link
        href="/admin/usage#input"
        className="rounded-xl border border-black/10 bg-white px-4 py-2.5 text-center text-[15px] font-semibold"
      >
        入力に戻って直す
      </Link>
      <form action={discardDraftAction}>
        <SubmitButton className="w-full rounded-xl px-4 py-2 text-sm text-foreground/70 underline">
          入力を破棄する
        </SubmitButton>
      </form>
    </Card>
  );
}

function ConfirmBox({ text }: { text: string }) {
  return (
    <label className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
      <input type="checkbox" name="confirmed" value="on" required className="mt-1" />
      {text}
    </label>
  );
}

function FailureForm() {
  return (
    <Card id="failure" title="監視障害を記録する">
      <p className="text-xs text-foreground/70">
        公式画面が開けない・読めないときに記録します。記録すると新規登録はすぐに停止し、既存Pushの送信は最長1時間で停止します。
      </p>
      <form action={failureAction} className="flex flex-col gap-3">
        <select name="kind" required defaultValue="" className={INPUT_CLASS}>
          <option value="" disabled>
            内容を選んでください
          </option>
          {Object.entries(P6_FAILURE_KIND_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <ConfirmBox text="記録すると停止が始まることを確認しました" />
        <SubmitButton className="rounded-xl bg-amber-600 px-4 py-2.5 text-[15px] font-semibold text-white">
          監視障害を記録する
        </SubmitButton>
      </form>
    </Card>
  );
}

function StopForm() {
  return (
    <Card id="stop" title="手動で停止する">
      <p className="text-xs text-foreground/70">
        新規登録・Token変更の確認・既存Pushの送信をすべてすぐに停止します。猶予はありません。
      </p>
      <form action={stopAction} className="flex flex-col gap-3">
        <select name="reason" required defaultValue="" className={INPUT_CLASS}>
          <option value="" disabled>
            理由を選んでください
          </option>
          {Object.entries(P6_STOP_REASON_CHOICES).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <ConfirmBox text="すべてをすぐに停止することを確認しました" />
        <SubmitButton className="rounded-xl bg-red-600 px-4 py-2.5 text-[15px] font-semibold text-white">
          手動で停止する
        </SubmitButton>
      </form>
    </Card>
  );
}

function ResumeForms({ status }: { status: P6Status }) {
  const targets = [
    { target: "send", label: "既存Pushの送信", refusal: status.resumeSendRefusal },
    { target: "registration", label: "新規登録", refusal: status.resumeRegistrationRefusal },
  ] as const;
  return (
    <Card id="resume" title="停止後の再開">
      <p className="text-xs text-foreground/70">
        停止後に公式画面を確認し、24時間以上空けてもう一度確認して、2回とも正常な場合だけ再開できます。自動では再開しません。
      </p>
      {targets.map(({ target, label, refusal }) =>
        refusal === null ? (
          <form key={target} action={resumeAction} data-resume={target} className="flex flex-col gap-3">
            <input type="hidden" name="target" value={target} />
            <input type="hidden" name="expectedVersion" value={status.state.version} />
            <ConfirmBox text={`停止後の2回の正常な確認を見て、${label}を再開することを確認しました`} />
            <SubmitButton className="rounded-xl bg-emerald-600 px-4 py-2.5 text-[15px] font-semibold text-white">
              {label}を再開する
            </SubmitButton>
          </form>
        ) : (
          <p key={target} data-resume-refusal={target} className="text-sm">
            {label}：{P6_RESUME_REFUSAL_LABELS[refusal] ?? "再開できません"}
          </p>
        ),
      )}
    </Card>
  );
}

function History({ status }: { status: P6Status }) {
  return (
    <Card id="history" title="過去の記録">
      {status.checks.length === 0 ? (
        <p className="text-sm text-foreground/70">記録はまだありません</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {status.checks.map((check) => (
            <li key={check.id} data-check={check.id}>
              <details className="rounded-xl border border-black/10 p-3 text-xs">
                <summary className="cursor-pointer">
                  {jst(check.checkedAt)}{" "}
                  <span className={check.isValid ? "text-emerald-700" : "text-red-700"}>
                    {check.isValid ? "有効" : "無効"}
                  </span>
                  {check.voidedReason !== null ? <span className="text-foreground/60">（無効化済み）</span> : null}
                </summary>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                  <dt className="text-foreground/60">登録時刻</dt>
                  <dd>{jst(check.recordedAt)}</dd>
                  <dt className="text-foreground/60">請求期間</dt>
                  <dd>
                    {check.periodStart} 〜 {check.periodEnd}
                  </dd>
                </dl>
                {check.invalidReasons.length > 0 ? (
                  <ul className="mt-2 list-disc pl-5 text-red-800">
                    {check.invalidReasons.map((code) => (
                      <li key={code}>{P6_INVALID_REASON_LABELS[code] ?? code}</li>
                    ))}
                  </ul>
                ) : null}
                <ValueList values={check.values} />
                {check.voidedReason === null ? (
                  <form action={voidAction} className="mt-2 flex flex-col gap-2">
                    <input type="hidden" name="checkId" value={check.id} />
                    <input type="hidden" name="expectedVersion" value={status.state.version} />
                    <select name="reason" required defaultValue="" className={INPUT_CLASS}>
                      <option value="" disabled>
                        無効にする理由
                      </option>
                      {Object.entries(P6_VOID_REASON_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                    <ConfirmBox text="この記録を無効にします（記録は残り、停止は解除されません）" />
                    <SubmitButton className="rounded-xl border border-red-300 bg-white px-4 py-2 text-sm font-semibold text-red-700">
                      この記録を無効にする
                    </SubmitButton>
                  </form>
                ) : null}
              </details>
            </li>
          ))}
        </ul>
      )}
      {status.failures.length > 0 ? (
        <p className="text-xs text-foreground/70">
          最新の監視障害：{P6_FAILURE_KIND_LABELS[status.failures[0].kind as keyof typeof P6_FAILURE_KIND_LABELS] ?? "—"}（
          {jst(status.failures[0].recordedAt)}）
        </p>
      ) : null}
      {status.manualStops.length > 0 ? (
        <p className="text-xs text-foreground/70">最新の手動停止：{jst(status.manualStops[0].stoppedAt)}</p>
      ) : null}
    </Card>
  );
}

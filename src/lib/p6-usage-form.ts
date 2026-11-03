import { parseJstDateTime } from "./sale-candidate-form";

// The P6 usage check form (/admin/usage): the eleven metrics read from the
// official Supabase dashboard, as the migration defines them
// (supabase/migrations/20261102120000_p6_usage_monitoring.sql). Quotas are
// the Pro plan quotas confirmed on the dashboard on 2026-11-02; the database
// holds the authoritative copy and refuses a different quota.
//
// The form is parsed here into the RPC's arguments; the database checks all
// of it again, converts units (MB and KB to GB, decimal) and works out the
// levels. Numbers stay decimal strings end to end, never JavaScript floats.

export type P6UnitKind = "bytes" | "count";
export type P6ByteUnit = "GB" | "MB" | "KB";

export type P6MetricDefinition = {
  code: string;
  label: string;
  // What the number is, in the admin's words.
  kindLabel: string;
  scope: "organization" | "project";
  scopeLabel: string;
  unitKind: P6UnitKind;
  // Quota as the database stores it: GB for bytes, a count otherwise.
  quota: string;
  quotaLabel: string;
  note?: string;
};

export const P6_METRICS: readonly P6MetricDefinition[] = [
  { code: "egress", label: "Egress", kindLabel: "期間の累計", scope: "organization", scopeLabel: "組織全体", unitKind: "bytes", quota: "250", quotaLabel: "250 GB" },
  { code: "cached_egress", label: "Cached Egress", kindLabel: "期間の累計", scope: "organization", scopeLabel: "組織全体", unitKind: "bytes", quota: "250", quotaLabel: "250 GB" },
  { code: "edge_function_invocations", label: "Edge Function Invocations", kindLabel: "期間の累計（回）", scope: "organization", scopeLabel: "組織全体", unitKind: "count", quota: "2000000", quotaLabel: "2,000,000 回" },
  { code: "monthly_active_users", label: "Monthly Active Users", kindLabel: "期間の累計（人）", scope: "organization", scopeLabel: "組織全体", unitKind: "count", quota: "100000", quotaLabel: "100,000 人", note: "公式画面の更新は24時間ごとの場合があります。" },
  { code: "storage_size", label: "Storage Size", kindLabel: "請求期間の平均", scope: "organization", scopeLabel: "組織全体", unitKind: "bytes", quota: "100", quotaLabel: "100 GB", note: "期間平均の値です。現在の容量ではありません。" },
  { code: "realtime_messages", label: "Realtime Messages", kindLabel: "期間の累計（件）", scope: "organization", scopeLabel: "組織全体", unitKind: "count", quota: "5000000", quotaLabel: "5,000,000 件" },
  { code: "realtime_peak_connections", label: "Realtime Peak Connections", kindLabel: "期間のピーク（接続）", scope: "organization", scopeLabel: "組織全体", unitKind: "count", quota: "500", quotaLabel: "500 接続" },
  { code: "log_ingestion", label: "Log Ingestion", kindLabel: "期間の累計", scope: "organization", scopeLabel: "組織全体", unitKind: "bytes", quota: "20", quotaLabel: "20 GB" },
  { code: "log_query", label: "Log Query", kindLabel: "期間の累計", scope: "organization", scopeLabel: "組織全体", unitKind: "bytes", quota: "2000", quotaLabel: "2,000 GB" },
  { code: "disk_size_preview", label: "Disk Size（Preview）", kindLabel: "確保容量（provisioned）", scope: "project", scopeLabel: "Preview プロジェクト", unitKind: "bytes", quota: "8", quotaLabel: "8 GB（Pro: 8 GB GP3 disk per project）" },
  { code: "disk_size_production", label: "Disk Size（Production）", kindLabel: "確保容量（provisioned）", scope: "project", scopeLabel: "Production プロジェクト", unitKind: "bytes", quota: "8", quotaLabel: "8 GB（Pro: 8 GB GP3 disk per project）" },
];

export const P6_BYTE_UNITS: readonly P6ByteUnit[] = ["GB", "MB", "KB"];

export const P6_SPEND_CAP_LABELS = { on: "有効", off: "無効", unknown: "分からない" } as const;
export type P6SpendCap = keyof typeof P6_SPEND_CAP_LABELS;

// Every form field the usage form has. Only these are kept for the draft.
export const P6_FORM_FIELDS: readonly string[] = [
  "checkedAt",
  "periodStart",
  "periodEnd",
  "spendCap",
  "dataAsOf",
  ...P6_METRICS.flatMap((metric) => [
    `${metric.code}.value`,
    `${metric.code}.unit`,
    `${metric.code}.quota`,
    `${metric.code}.unavailable`,
  ]),
];

const FIELD_MAX_LENGTH = 40;

export type P6RawForm = Record<string, string>;

// The known fields only, trimmed to a short length (anything else is dropped).
export function pickP6RawForm(read: (name: string) => unknown): P6RawForm {
  const raw: P6RawForm = {};
  for (const name of P6_FORM_FIELDS) {
    const value = read(name);
    if (typeof value === "string" && value.length <= FIELD_MAX_LENGTH) raw[name] = value;
  }
  return raw;
}

export type P6ValueEntry =
  | { metric: string; status: "measured"; value: string; unit: string; quota: string }
  | { metric: string; status: "unavailable" };

export type P6UsageCheckDraft = {
  checkedAt: Date;
  periodStart: string;
  periodEnd: string;
  spendCap: P6SpendCap;
  dataAsOf: Date | null;
  values: P6ValueEntry[];
};

export type P6FormError = "checked_at" | "period" | "spend_cap" | "data_as_of" | "value";

export type P6ParseResult = { ok: true; value: P6UsageCheckDraft } | { ok: false; error: P6FormError };

const DECIMAL = /^\d{1,15}(\.\d{1,9})?$/;
const INTEGER = /^\d{1,15}$/;

// Full-width digits and separators are folded (NFKC); thousands separators
// and spaces are removed. Signs, exponents and anything else are refused.
export function normalizeP6Number(raw: string | undefined, unitKind: P6UnitKind): string | null {
  if (raw === undefined) return null;
  const text = raw.normalize("NFKC").replace(/[,\s]/g, "");
  return (unitKind === "count" ? INTEGER : DECIMAL).test(text) ? text : null;
}

function parseDate(raw: string | undefined): string | null {
  const match = raw?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  return check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
    ? match[0]
    : null;
}

export function parseP6UsageForm(raw: P6RawForm): P6ParseResult {
  const checkedAt = parseJstDateTime(raw.checkedAt ?? null);
  if (checkedAt === null) return { ok: false, error: "checked_at" };

  const periodStart = parseDate(raw.periodStart);
  const periodEnd = parseDate(raw.periodEnd);
  if (periodStart === null || periodEnd === null || periodEnd <= periodStart) return { ok: false, error: "period" };

  const spendCap = raw.spendCap;
  if (spendCap !== "on" && spendCap !== "off" && spendCap !== "unknown") return { ok: false, error: "spend_cap" };

  let dataAsOf: Date | null = null;
  if (raw.dataAsOf !== undefined && raw.dataAsOf !== "") {
    dataAsOf = parseJstDateTime(raw.dataAsOf);
    if (dataAsOf === null) return { ok: false, error: "data_as_of" };
  }

  const values: P6ValueEntry[] = [];
  for (const metric of P6_METRICS) {
    // "取得できなかった" is an explicit choice; an empty field is not.
    if (raw[`${metric.code}.unavailable`] === "on") {
      values.push({ metric: metric.code, status: "unavailable" });
      continue;
    }
    const value = normalizeP6Number(raw[`${metric.code}.value`], metric.unitKind);
    const quota = normalizeP6Number(raw[`${metric.code}.quota`], metric.unitKind);
    const unit = metric.unitKind === "count" ? "count" : raw[`${metric.code}.unit`];
    if (value === null || quota === null || !(unit === "count" || P6_BYTE_UNITS.includes(unit as P6ByteUnit))) {
      return { ok: false, error: "value" };
    }
    values.push({ metric: metric.code, status: "measured", value, unit: unit as string, quota });
  }

  return { ok: true, value: { checkedAt, periodStart, periodEnd, spendCap, dataAsOf, values } };
}

// Levels as the database reports them (0 = below 60%).
export const P6_LEVEL_LABELS: Record<number, string> = {
  0: "60%未満",
  60: "60%以上：監視強化",
  80: "80%以上：警告",
  90: "90%以上：新規登録停止",
  95: "95%以上：送信停止",
};

// Why a check is invalid (codes from the database).
export const P6_INVALID_REASON_LABELS: Record<string, string> = {
  metric_unavailable: "取得できなかった項目があります",
  quota_mismatch: "上限が Pro プランの上限と一致しません",
  spend_cap_not_on: "Spend Cap が有効ではありません",
  checked_at_future: "確認時刻が未来です",
  recorded_too_late: "公式画面の確認から1時間を超えています",
  checked_at_not_newer: "前回の確認時刻より新しくありません",
  period_invalid: "請求期間の長さが正しくありません",
  period_not_current: "確認時刻が請求期間の中にありません（境目の前後を含む）",
  period_mismatch: "前回の請求期間とつながっていません",
  usage_decreased: "前回より減ってはいけない値が減っています",
  data_as_of_future: "データの対象時刻が確認時刻より後です",
  data_stale: "データの対象時刻が古すぎます",
};

// Why a target is stopped (codes from the database).
export const P6_STOP_REASON_LABELS: Record<string, string> = {
  not_started: "まだ一度も再開されていません",
  manual_stop: "管理者による手動停止",
  usage_90: "使用率90%以上",
  usage_95: "使用率95%以上",
  expired: "確認期限切れ",
  monitoring_failure: "監視障害の記録",
  invalid_check: "無効な確認の記録",
  no_measurement: "有効な確認がありません",
};

// Why a resume is refused (codes from the database).
export const P6_RESUME_REFUSAL_LABELS: Record<string, string> = {
  not_stopped: "停止していません",
  no_valid_check: "有効な確認がありません",
  no_check_after_stop: "停止後に確認・記録した有効な確認がありません",
  check_expired: "最新の確認が期限切れです",
  second_check_missing: "停止後に24時間以上空けた2回の有効な確認がありません",
  failure_between_checks: "2回の確認の間に監視障害が記録されています",
  invalid_between_checks: "2回の確認の間に無効な確認が記録されています",
  gap_between_checks: "2回の確認の間に期限切れがありました",
  usage_too_high: "確認の使用率が停止の閾値以上です",
};

export const P6_FAILURE_KIND_LABELS = {
  dashboard_unavailable: "公式画面が開けない",
  usage_unreadable: "使用量が読めない",
  other: "その他",
} as const;

export const P6_STOP_REASON_CHOICES = {
  usage_concern: "使用量が心配",
  monitoring_concern: "監視ができない",
  other: "その他",
} as const;

export const P6_VOID_REASON_LABELS = {
  input_error: "入力の間違い",
  wrong_period: "請求期間の間違い",
  other: "その他",
} as const;

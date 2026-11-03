import { describe, expect, it } from "vitest";
import {
  P6_FORM_FIELDS,
  P6_METRICS,
  normalizeP6Number,
  parseP6UsageForm,
  pickP6RawForm,
  type P6RawForm,
} from "./p6-usage-form";

// The 2026-11-02 dashboard reading (Human check), as the admin would type it.
function validForm(overrides: P6RawForm = {}): P6RawForm {
  return {
    checkedAt: "2026-11-02T21:30",
    periodStart: "2026-11-02",
    periodEnd: "2026-12-02",
    spendCap: "on",
    dataAsOf: "",
    "egress.value": "0.008",
    "egress.unit": "GB",
    "egress.quota": "250",
    "cached_egress.value": "0",
    "cached_egress.unit": "GB",
    "cached_egress.quota": "250",
    "edge_function_invocations.value": "0",
    "edge_function_invocations.quota": "2,000,000",
    "monthly_active_users.value": "4",
    "monthly_active_users.quota": "100,000",
    "storage_size.value": "0.00",
    "storage_size.unit": "GB",
    "storage_size.quota": "100",
    "realtime_messages.value": "0",
    "realtime_messages.quota": "5,000,000",
    "realtime_peak_connections.value": "0",
    "realtime_peak_connections.quota": "500",
    "log_ingestion.value": "0.15",
    "log_ingestion.unit": "GB",
    "log_ingestion.quota": "20",
    "log_query.value": "23.337",
    "log_query.unit": "GB",
    "log_query.quota": "2,000",
    "disk_size_preview.value": "2",
    "disk_size_preview.unit": "GB",
    "disk_size_preview.quota": "8",
    "disk_size_production.value": "2",
    "disk_size_production.unit": "GB",
    "disk_size_production.quota": "8",
    ...overrides,
  };
}

describe("P6 metric definitions", () => {
  it("lists the eleven required metrics in database order, organization first, two project disks", () => {
    expect(P6_METRICS.map((metric) => metric.code)).toEqual([
      "egress",
      "cached_egress",
      "edge_function_invocations",
      "monthly_active_users",
      "storage_size",
      "realtime_messages",
      "realtime_peak_connections",
      "log_ingestion",
      "log_query",
      "disk_size_preview",
      "disk_size_production",
    ]);
    expect(P6_METRICS.filter((metric) => metric.scope === "project").map((metric) => metric.code)).toEqual([
      "disk_size_preview",
      "disk_size_production",
    ]);
  });

  it("uses the Pro quotas the migration holds", () => {
    expect(Object.fromEntries(P6_METRICS.map((metric) => [metric.code, `${metric.quota}:${metric.unitKind}`]))).toEqual({
      egress: "250:bytes",
      cached_egress: "250:bytes",
      edge_function_invocations: "2000000:count",
      monthly_active_users: "100000:count",
      storage_size: "100:bytes",
      realtime_messages: "5000000:count",
      realtime_peak_connections: "500:count",
      log_ingestion: "20:bytes",
      log_query: "2000:bytes",
      disk_size_preview: "8:bytes",
      disk_size_production: "8:bytes",
    });
  });

  it("labels Storage Size as the period average, not the current size", () => {
    const storage = P6_METRICS.find((metric) => metric.code === "storage_size");
    expect(storage?.kindLabel).toBe("請求期間の平均");
    expect(storage?.note).toContain("現在の容量ではありません");
  });
});

describe("normalizeP6Number", () => {
  it.each([
    ["0.008", "bytes", "0.008"],
    ["2,000,000", "count", "2000000"],
    ["２０００", "count", "2000"],
    [" 23.337 ", "bytes", "23.337"],
    ["0", "count", "0"],
  ] as const)("accepts %j (%s)", (raw, kind, expected) => {
    expect(normalizeP6Number(raw, kind)).toBe(expected);
  });

  it.each([
    ["", "bytes"],
    ["-1", "bytes"],
    ["1e3", "bytes"],
    ["abc", "bytes"],
    ["1.5", "count"],
    [".5", "bytes"],
    ["1.", "bytes"],
    ["1234567890123456", "count"],
  ] as const)("refuses %j (%s)", (raw, kind) => {
    expect(normalizeP6Number(raw, kind)).toBeNull();
  });

  it("refuses a missing field", () => {
    expect(normalizeP6Number(undefined, "bytes")).toBeNull();
  });
});

describe("parseP6UsageForm", () => {
  it("parses the 2026-11-02 reading into eleven measured values (JST time, decimal strings)", () => {
    const result = parseP6UsageForm(validForm());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.checkedAt.toISOString()).toBe("2026-11-02T12:30:00.000Z");
    expect(result.value.periodStart).toBe("2026-11-02");
    expect(result.value.periodEnd).toBe("2026-12-02");
    expect(result.value.spendCap).toBe("on");
    expect(result.value.dataAsOf).toBeNull();
    expect(result.value.values).toHaveLength(11);
    expect(result.value.values[0]).toEqual({ metric: "egress", status: "measured", value: "0.008", unit: "GB", quota: "250" });
    expect(result.value.values[2]).toEqual({
      metric: "edge_function_invocations",
      status: "measured",
      value: "0",
      unit: "count",
      quota: "2000000",
    });
  });

  it("keeps the byte unit chosen (conversion happens on the server)", () => {
    const result = parseP6UsageForm(validForm({ "egress.value": "8", "egress.unit": "MB" }));
    expect(result.ok && result.value.values[0]).toEqual({ metric: "egress", status: "measured", value: "8", unit: "MB", quota: "250" });
  });

  it("ignores a unit sent for a count metric", () => {
    const result = parseP6UsageForm(validForm({ "monthly_active_users.unit": "GB" }));
    expect(result.ok && result.value.values[3]).toMatchObject({ unit: "count" });
  });

  it("records an explicitly unavailable metric as unavailable, never as 0", () => {
    const result = parseP6UsageForm(
      validForm({ "storage_size.unavailable": "on", "storage_size.value": "", "storage_size.quota": "" }),
    );
    expect(result.ok && result.value.values[4]).toEqual({ metric: "storage_size", status: "unavailable" });
  });

  it("refuses an empty value that is not marked unavailable", () => {
    expect(parseP6UsageForm(validForm({ "storage_size.value": "" }))).toEqual({ ok: false, error: "value" });
  });

  it.each([
    [{ "egress.unit": "TB" }, "value"],
    [{ "egress.quota": "" }, "value"],
    [{ "monthly_active_users.value": "4.5" }, "value"],
    [{ checkedAt: "" }, "checked_at"],
    [{ checkedAt: "2026-02-30T10:00" }, "checked_at"],
    [{ periodStart: "2026-12-02" }, "period"],
    [{ periodEnd: "2026-13-01" }, "period"],
    [{ spendCap: "" }, "spend_cap"],
    [{ spendCap: "yes" }, "spend_cap"],
    [{ dataAsOf: "yesterday" }, "data_as_of"],
  ] as const)("refuses %j with %s", (overrides, error) => {
    expect(parseP6UsageForm(validForm(overrides))).toEqual({ ok: false, error });
  });

  it("keeps a data time when the dashboard shows one", () => {
    const result = parseP6UsageForm(validForm({ dataAsOf: "2026-11-02T20:00" }));
    expect(result.ok && result.value.dataAsOf?.toISOString()).toBe("2026-11-02T11:00:00.000Z");
  });
});

describe("pickP6RawForm", () => {
  it("keeps only the known fields, as short strings", () => {
    const source: Record<string, unknown> = {
      checkedAt: "2026-11-02T21:30",
      "egress.value": "0.008",
      unknown: "x",
      periodStart: 20261102,
      periodEnd: "x".repeat(41),
    };
    expect(pickP6RawForm((name) => source[name])).toEqual({ checkedAt: "2026-11-02T21:30", "egress.value": "0.008" });
    expect(P6_FORM_FIELDS).toHaveLength(5 + 11 * 4);
  });
});

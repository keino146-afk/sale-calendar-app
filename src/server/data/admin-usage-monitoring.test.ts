import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  getP6Status,
  parseP6Status,
  previewP6UsageCheck,
  recordP6MonitoringFailure,
  recordP6UsageCheck,
  resumeP6,
  stopP6,
  voidP6UsageCheck,
} = await import("./admin-usage-monitoring");

const CHECK_ID = "44444444-4444-4444-8444-444444444444";

const STATE = {
  evaluated_at: "2026-11-06T00:10:00+00:00",
  registration_allowed: false,
  token_change_allowed: true,
  sends_allowed: true,
  send_in_grace: false,
  registration_stop_at: "-infinity",
  registration_stop_reason: "not_started",
  send_stop_at: "2026-11-07T06:00:00+00:00",
  send_stop_reason: "expired",
  monitoring_incident_at: "2026-11-07T05:00:00+00:00",
  send_grace_until: "2026-11-07T06:00:00+00:00",
  registration_resumed_at: null,
  send_resumed_at: "2026-11-06T00:10:00+00:00",
  current_check_id: CHECK_ID,
  current_check_registration_deadline: "2026-11-07T05:00:00+00:00",
  current_check_send_deadline: "2026-11-07T06:00:00+00:00",
  current_max_level: 0,
  manual_stop_active: false,
  version: 7,
};

const STATUS = {
  state: STATE,
  resume_registration_refusal: "second_check_missing",
  resume_send_refusal: "not_stopped",
  metrics: [],
  checks: [
    {
      id: CHECK_ID,
      checked_at: "2026-11-06T00:00:00+00:00",
      recorded_at: "2026-11-06T00:05:00+00:00",
      period_start: "2026-11-02",
      period_end: "2026-12-02",
      spend_cap: "on",
      data_as_of: null,
      is_valid: true,
      invalid_reasons: [],
      voided_reason: null,
      voided_at: null,
      values: [
        { metric: "egress", status: "measured", entered_value: "0.008", entered_unit: "GB", usage: "0.008", level: 0, percent: "0.003" },
        { metric: "storage_size", status: "unavailable", entered_value: null, entered_unit: null, usage: null, level: null, percent: null },
      ],
    },
  ],
  failures: [{ id: "f1", kind: "other", recorded_at: "2026-11-06T01:00:00+00:00" }],
  manual_stops: [],
  warnings: [{ id: "w1", created_at: "2026-11-06T00:05:00+00:00", kind: "usage", level: 60, metric: "egress", period_start: "2026-11-02" }],
};

function client(result: { data?: unknown; error: { code?: string; message?: string } | null } | Error) {
  return {
    rpc: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
    from: vi.fn(),
  };
}

const DRAFT = {
  checkedAt: new Date("2026-11-06T00:00:00Z"),
  periodStart: "2026-11-02",
  periodEnd: "2026-12-02",
  spendCap: "on" as const,
  dataAsOf: null,
  values: [{ metric: "egress", status: "measured" as const, value: "0.008", unit: "GB", quota: "250" }],
};

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseP6Status", () => {
  it("reads the state, refusals, checks and lists", () => {
    const status = parseP6Status(STATUS);
    expect(status?.state).toMatchObject({
      registrationAllowed: false,
      tokenChangeAllowed: true,
      sendsAllowed: true,
      // -infinity (never resumed) is not a time the page can show.
      registrationStopAt: null,
      registrationStopReason: "not_started",
      sendGraceUntil: "2026-11-07T06:00:00+00:00",
      version: 7,
    });
    expect(status?.resumeRegistrationRefusal).toBe("second_check_missing");
    expect(status?.checks[0].values[1]).toEqual({
      metric: "storage_size",
      status: "unavailable",
      enteredValue: null,
      enteredUnit: null,
      usage: null,
      percent: null,
      level: null,
    });
    expect(status?.warnings[0]).toMatchObject({ kind: "usage", level: 60, metric: "egress" });
  });

  it.each([
    ["no state", { ...STATUS, state: null }],
    ["a missing flag", { ...STATUS, state: { ...STATE, sends_allowed: "yes" } }],
    ["a missing version", { ...STATUS, state: { ...STATE, version: null } }],
    ["a malformed check", { ...STATUS, checks: [{ id: CHECK_ID }] }],
    ["an unknown value status", { ...STATUS, checks: [{ ...STATUS.checks[0], values: [{ metric: "egress", status: "zero" }] }] }],
    ["a malformed warning list", { ...STATUS, warnings: {} }],
  ])("refuses %s", (_label, value) => {
    expect(parseP6Status(value as never)).toBeNull();
  });
});

describe("getP6Status", () => {
  it("calls only the status RPC, without arguments", async () => {
    const c = client({ data: STATUS, error: null });
    const status = await getP6Status(c as never);
    expect(status.state.version).toBe(7);
    expect(c.rpc).toHaveBeenCalledWith("admin_get_p6_status");
    expect(c.from).not.toHaveBeenCalled();
  });

  it("throws a generic error and logs only the code", async () => {
    const c = client({ error: { code: "42501", message: "insufficient privilege SECRET" } });
    await expect(getP6Status(c as never)).rejects.toThrow("Failed to load usage monitoring status");
    expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("SECRET");
  });

  it("throws on an unexpected result", async () => {
    await expect(getP6Status(client({ data: { state: null }, error: null }) as never)).rejects.toThrow();
  });
});

describe("usage check RPC", () => {
  const PREVIEW = {
    committed: false,
    valid: true,
    reasons: [],
    values: [{ metric: "egress", status: "measured", entered_value: "0.008", entered_unit: "GB", usage: "0.008", quota: "250", entered_quota: "250", percent: "0.003", level: 0 }],
    evaluated_at: "2026-11-06T00:05:00+00:00",
    version: 3,
  };

  it("validates without storing: p_commit false and no expected values", async () => {
    const c = client({ data: PREVIEW, error: null });
    const result = await previewP6UsageCheck(c as never, DRAFT);
    expect(result).toMatchObject({ ok: true, preview: { valid: true, version: 3 } });
    expect(c.rpc).toHaveBeenCalledWith("admin_record_p6_usage_check", {
      p_checked_at: "2026-11-06T00:00:00.000Z",
      p_period_start: "2026-11-02",
      p_period_end: "2026-12-02",
      p_spend_cap: "on",
      p_data_as_of: null,
      p_values: DRAFT.values,
      p_commit: false,
      p_expected_version: null,
      p_expected_valid: null,
    });
  });

  it("stores with the confirmed version and validity", async () => {
    const c = client({ data: { ...PREVIEW, committed: true, check_id: CHECK_ID, version: 4 }, error: null });
    expect(await recordP6UsageCheck(c as never, DRAFT, { version: 3, valid: true })).toEqual({ ok: true, valid: true });
    expect(c.rpc).toHaveBeenCalledWith(
      "admin_record_p6_usage_check",
      expect.objectContaining({ p_commit: true, p_expected_version: 3, p_expected_valid: true }),
    );
  });

  it.each([
    ["P0409", "stale"],
    ["23505", "duplicate"],
    ["22023", "invalid_input"],
    ["42501", "failed"],
    [undefined, "failed"],
  ])("maps error %s to %s", async (code, reason) => {
    expect(await recordP6UsageCheck(client({ error: { code } }) as never, DRAFT, { version: 3, valid: true })).toEqual({
      ok: false,
      reason,
    });
  });

  it("treats a thrown client error or an uncommitted answer as a failure", async () => {
    expect(await recordP6UsageCheck(client(new TypeError("x")) as never, DRAFT, { version: 3, valid: true })).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await recordP6UsageCheck(client({ data: PREVIEW, error: null }) as never, DRAFT, { version: 3, valid: true })).toEqual({
      ok: false,
      reason: "failed",
    });
  });
});

describe("other P6 RPCs", () => {
  it("voids with reason and version", async () => {
    const c = client({ data: null, error: null });
    expect(await voidP6UsageCheck(c as never, { checkId: CHECK_ID, reason: "input_error", expectedVersion: 5 })).toEqual({ ok: true });
    expect(c.rpc).toHaveBeenCalledWith("admin_void_p6_usage_check", { p_check_id: CHECK_ID, p_reason: "input_error", p_expected_version: 5 });
    expect(await voidP6UsageCheck(client({ error: { code: "P0002" } }) as never, { checkId: CHECK_ID, reason: "other", expectedVersion: 5 })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });

  it("records a failure and a manual stop without a version (safe side)", async () => {
    const failure = client({ data: "id", error: null });
    expect(await recordP6MonitoringFailure(failure as never, "dashboard_unavailable")).toEqual({ ok: true });
    expect(failure.rpc).toHaveBeenCalledWith("admin_record_p6_monitoring_failure", { p_kind: "dashboard_unavailable" });
    const stop = client({ data: "id", error: null });
    expect(await stopP6(stop as never, "usage_concern")).toEqual({ ok: true });
    expect(stop.rpc).toHaveBeenCalledWith("admin_stop_p6", { p_reason: "usage_concern" });
  });

  it("resumes, or reports the database's refusal", async () => {
    const ok = client({ data: { ok: true }, error: null });
    expect(await resumeP6(ok as never, { target: "send", expectedVersion: 9 })).toEqual({ ok: true });
    expect(ok.rpc).toHaveBeenCalledWith("admin_resume_p6", { p_target: "send", p_expected_version: 9 });
    expect(await resumeP6(client({ data: { ok: false, reason: "second_check_missing" }, error: null }) as never, { target: "registration", expectedVersion: 9 })).toEqual({
      ok: false,
      reason: "refused:second_check_missing",
    });
    expect(await resumeP6(client({ data: { ok: false, reason: "<script>" }, error: null }) as never, { target: "send", expectedVersion: 9 })).toEqual({
      ok: false,
      reason: "failed",
    });
    expect(await resumeP6(client({ error: { code: "P0409" } }) as never, { target: "send", expectedVersion: 9 })).toEqual({
      ok: false,
      reason: "stale",
    });
  });
});

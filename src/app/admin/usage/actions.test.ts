import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RedirectSentinel extends Error {
    constructor(public readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return {
    isSameOriginRequest: vi.fn(),
    requireAdmin: vi.fn(),
    recordP6UsageCheck: vi.fn(),
    recordP6MonitoringFailure: vi.fn(),
    stopP6: vi.fn(),
    resumeP6: vi.fn(),
    voidP6UsageCheck: vi.fn(),
    saveP6Draft: vi.fn(),
    readP6Draft: vi.fn(),
    clearP6Draft: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new RedirectSentinel(url);
    }),
    REDIRECT: RedirectSentinel,
  };
});

vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth/admin-auth", () => ({ isSameOriginRequest: mocks.isSameOriginRequest }));
vi.mock("@/server/auth/admin-session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/server/data/admin-usage-monitoring", () => ({
  recordP6UsageCheck: mocks.recordP6UsageCheck,
  recordP6MonitoringFailure: mocks.recordP6MonitoringFailure,
  stopP6: mocks.stopP6,
  resumeP6: mocks.resumeP6,
  voidP6UsageCheck: mocks.voidP6UsageCheck,
}));
// The cookie store is mocked; the digest is the real one, so a commit must
// carry the digest of exactly the draft it reads.
vi.mock("./draft-cookie", async (importOriginal) => ({
  saveP6Draft: mocks.saveP6Draft,
  readP6Draft: mocks.readP6Draft,
  clearP6Draft: mocks.clearP6Draft,
  p6DraftDigest: (await importOriginal<typeof import("./draft-cookie")>()).p6DraftDigest,
}));

const actions = await import("./actions");
const { p6DraftDigest } = await import("./draft-cookie");

const CLIENT = { fake: "admin client" };
const CHECK_ID = "44444444-4444-4444-8444-444444444444";

// A distinctive number, to prove it never reaches a URL.
const SECRETISH_VALUE = "123.456789";

function rawForm(overrides: Record<string, string> = {}): Record<string, string> {
  const fields: Record<string, string> = {
    checkedAt: "2026-11-02T21:30",
    periodStart: "2026-11-02",
    periodEnd: "2026-12-02",
    spendCap: "on",
  };
  for (const code of ["egress", "cached_egress", "storage_size", "log_ingestion", "log_query", "disk_size_preview", "disk_size_production"]) {
    fields[`${code}.value`] = code === "egress" ? SECRETISH_VALUE : "0";
    fields[`${code}.unit`] = "GB";
    fields[`${code}.quota`] = { egress: "250", cached_egress: "250", storage_size: "100", log_ingestion: "20", log_query: "2000", disk_size_preview: "8", disk_size_production: "8" }[code] as string;
  }
  for (const [code, quota] of [["edge_function_invocations", "2000000"], ["monthly_active_users", "100000"], ["realtime_messages", "5000000"], ["realtime_peak_connections", "500"]]) {
    fields[`${code}.value`] = "0";
    fields[`${code}.quota`] = quota;
  }
  return { ...fields, ...overrides };
}

// The confirmation form as the page renders it for the draft shown.
function commitForm(overrides: Record<string, string> = {}, shown: Record<string, string> = rawForm()) {
  return form({ confirmed: "on", expectedVersion: "3", expectedValid: "true", draftDigest: p6DraftDigest(shown), ...overrides });
}

function form(fields: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

async function redirectUrl(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof mocks.REDIRECT) return error.url;
    throw error;
  }
  throw new Error("expected a redirect");
}

beforeEach(() => {
  mocks.isSameOriginRequest.mockResolvedValue(true);
  mocks.requireAdmin.mockResolvedValue(CLIENT);
  mocks.readP6Draft.mockResolvedValue(rawForm());
  mocks.saveP6Draft.mockResolvedValue(true);
  mocks.recordP6UsageCheck.mockResolvedValue({ ok: true, valid: true });
  mocks.recordP6MonitoringFailure.mockResolvedValue({ ok: true });
  mocks.stopP6.mockResolvedValue({ ok: true });
  mocks.resumeP6.mockResolvedValue({ ok: true });
  mocks.voidP6UsageCheck.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

const ALL_ACTIONS = [
  ["previewUsageAction", () => actions.previewUsageAction(form(rawForm()))],
  ["commitUsageAction", () => actions.commitUsageAction(commitForm())],
  ["discardDraftAction", () => actions.discardDraftAction()],
  ["failureAction", () => actions.failureAction(form({ kind: "other", confirmed: "on" }))],
  ["stopAction", () => actions.stopAction(form({ reason: "other", confirmed: "on" }))],
  ["resumeAction", () => actions.resumeAction(form({ target: "send", expectedVersion: "3", confirmed: "on" }))],
  ["voidAction", () => actions.voidAction(form({ checkId: CHECK_ID, reason: "other", expectedVersion: "3", confirmed: "on" }))],
] as const;

describe("every P6 action", () => {
  it.each(ALL_ACTIONS)("%s refuses a cross-site request before the admin check and any write", async (_name, run) => {
    mocks.isSameOriginRequest.mockResolvedValue(false);
    expect(await redirectUrl(run())).toBe("/admin/usage");
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    for (const write of [mocks.recordP6UsageCheck, mocks.recordP6MonitoringFailure, mocks.stopP6, mocks.resumeP6, mocks.voidP6UsageCheck, mocks.saveP6Draft, mocks.clearP6Draft]) {
      expect(write).not.toHaveBeenCalled();
    }
  });

  it.each(ALL_ACTIONS)("%s stops at the admin guard for non-admins", async (_name, run) => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login"));
    expect(await redirectUrl(run())).toBe("/admin/login");
    for (const write of [mocks.recordP6UsageCheck, mocks.recordP6MonitoringFailure, mocks.stopP6, mocks.resumeP6, mocks.voidP6UsageCheck, mocks.saveP6Draft, mocks.clearP6Draft]) {
      expect(write).not.toHaveBeenCalled();
    }
  });
});

describe("previewUsageAction", () => {
  it("keeps the form in the draft cookie and shows the confirmation without numbers in the URL", async () => {
    const url = await redirectUrl(actions.previewUsageAction(form({ ...rawForm(), unexpected: "x" })));
    expect(url).toBe("/admin/usage?step=confirm#confirm");
    expect(mocks.saveP6Draft).toHaveBeenCalledTimes(1);
    const saved = mocks.saveP6Draft.mock.calls[0][0] as Record<string, string>;
    expect(saved["egress.value"]).toBe(SECRETISH_VALUE);
    expect(saved).not.toHaveProperty("unexpected");
    expect(mocks.recordP6UsageCheck).not.toHaveBeenCalled();
  });

  it("returns to the form with a fixed code on bad input, still without numbers in the URL", async () => {
    const url = await redirectUrl(actions.previewUsageAction(form(rawForm({ "storage_size.value": "" }))));
    expect(url).toBe("/admin/usage?error=value#input");
    expect(url).not.toContain(SECRETISH_VALUE);
    expect(mocks.saveP6Draft).toHaveBeenCalledTimes(1);
  });

  it("stops at a draft too large to keep: no confirmation step, no numbers in the URL", async () => {
    mocks.saveP6Draft.mockResolvedValue(false);
    const url = await redirectUrl(actions.previewUsageAction(form(rawForm())));
    expect(url).toBe("/admin/usage?error=draft_too_large#input");
    expect(url).not.toContain("step=confirm");
    expect(url).not.toContain(SECRETISH_VALUE);
    expect(mocks.recordP6UsageCheck).not.toHaveBeenCalled();
  });

  it("reports the size before any input error (the old draft is gone either way)", async () => {
    mocks.saveP6Draft.mockResolvedValue(false);
    expect(await redirectUrl(actions.previewUsageAction(form(rawForm({ "storage_size.value": "" }))))).toBe(
      "/admin/usage?error=draft_too_large#input",
    );
  });
});

describe("commitUsageAction", () => {
  it("stores the confirmed draft with the page version and shown validity, then clears the draft", async () => {
    const url = await redirectUrl(actions.commitUsageAction(commitForm()));
    expect(url).toBe("/admin/usage?done=recorded");
    expect(mocks.recordP6UsageCheck).toHaveBeenCalledTimes(1);
    const [client, draft, expected] = mocks.recordP6UsageCheck.mock.calls[0];
    expect(client).toBe(CLIENT);
    expect(expected).toEqual({ version: 3, valid: true });
    expect(draft.values[0]).toEqual({ metric: "egress", status: "measured", value: SECRETISH_VALUE, unit: "GB", quota: "250" });
    expect(mocks.clearP6Draft).toHaveBeenCalledTimes(1);
  });

  it("reports an invalid check as stored-invalid", async () => {
    mocks.recordP6UsageCheck.mockResolvedValue({ ok: true, valid: false });
    expect(await redirectUrl(actions.commitUsageAction(commitForm({ expectedValid: "false" })))).toBe(
      "/admin/usage?done=recorded_invalid",
    );
  });

  it("needs the confirmation checkbox", async () => {
    expect(await redirectUrl(actions.commitUsageAction(form({ expectedVersion: "3", expectedValid: "true" })))).toBe(
      "/admin/usage?step=confirm&error=confirm_required#confirm",
    );
    expect(mocks.recordP6UsageCheck).not.toHaveBeenCalled();
  });

  it.each([
    [{ confirmed: "on", expectedValid: "true" }],
    [{ confirmed: "on", expectedVersion: "x", expectedValid: "true" }],
    [{ confirmed: "on", expectedVersion: "3", expectedValid: "yes" }],
  ])("treats a missing page version or validity as stale (%j)", async (fields) => {
    expect(await redirectUrl(actions.commitUsageAction(form(fields)))).toBe("/admin/usage?step=confirm&error=stale#confirm");
    expect(mocks.recordP6UsageCheck).not.toHaveBeenCalled();
  });

  it("asks again when the draft is gone", async () => {
    mocks.readP6Draft.mockResolvedValue(null);
    expect(await redirectUrl(actions.commitUsageAction(commitForm()))).toBe(
      "/admin/usage?error=draft_missing#input",
    );
    expect(mocks.recordP6UsageCheck).not.toHaveBeenCalled();
  });

  it("goes back to the confirmation when the database says stale, keeping the draft", async () => {
    mocks.recordP6UsageCheck.mockResolvedValue({ ok: false, reason: "stale" });
    expect(await redirectUrl(actions.commitUsageAction(commitForm()))).toBe(
      "/admin/usage?step=confirm&error=stale#confirm",
    );
    expect(mocks.clearP6Draft).not.toHaveBeenCalled();
  });

  it("reports a duplicate reading", async () => {
    mocks.recordP6UsageCheck.mockResolvedValue({ ok: false, reason: "duplicate" });
    expect(await redirectUrl(actions.commitUsageAction(commitForm()))).toBe(
      "/admin/usage?error=duplicate#input",
    );
  });

  it("refuses a draft changed after it was shown (another tab) and asks for a new confirmation", async () => {
    // Tab A was shown rawForm(); tab B then confirmed other numbers.
    mocks.readP6Draft.mockResolvedValue(rawForm({ "egress.value": "200" }));
    const url = await redirectUrl(actions.commitUsageAction(commitForm()));
    expect(url).toBe("/admin/usage?step=confirm&error=draft_changed#confirm");
    expect(url).not.toContain(SECRETISH_VALUE);
    expect(mocks.recordP6UsageCheck).not.toHaveBeenCalled();
    // Kept, so the current draft is what the new confirmation shows.
    expect(mocks.clearP6Draft).not.toHaveBeenCalled();
  });

  it("refuses a change in any one field, even with the same version and validity", async () => {
    for (const [name, value] of [["checkedAt", "2026-11-02T21:31"], ["egress.unit", "MB"], ["storage_size.unavailable", "on"], ["dataAsOf", "2026-11-02T20:00"]]) {
      mocks.readP6Draft.mockResolvedValue(rawForm({ [name]: value }));
      expect(await redirectUrl(actions.commitUsageAction(commitForm()))).toBe("/admin/usage?step=confirm&error=draft_changed#confirm");
    }
    expect(mocks.recordP6UsageCheck).not.toHaveBeenCalled();
  });

  it.each([
    ["no digest", { draftDigest: "" }],
    ["a malformed digest", { draftDigest: "x".repeat(64) }],
    ["an upper-case digest", { draftDigest: p6DraftDigest(rawForm()).toUpperCase() }],
    ["the digest of an empty draft", { draftDigest: p6DraftDigest({}) }],
  ])("cannot skip the content check with %s", async (_label, overrides) => {
    expect(await redirectUrl(actions.commitUsageAction(commitForm(overrides)))).toBe("/admin/usage?step=confirm&error=draft_changed#confirm");
    expect(mocks.recordP6UsageCheck).not.toHaveBeenCalled();
  });

  it("cannot skip it by leaving the digest field out", async () => {
    expect(
      await redirectUrl(actions.commitUsageAction(form({ confirmed: "on", expectedVersion: "3", expectedValid: "true" }))),
    ).toBe("/admin/usage?step=confirm&error=draft_changed#confirm");
    expect(mocks.recordP6UsageCheck).not.toHaveBeenCalled();
  });

  it("stores the same content whatever order its fields come in", async () => {
    mocks.readP6Draft.mockResolvedValue(Object.fromEntries(Object.entries(rawForm()).reverse()));
    expect(await redirectUrl(actions.commitUsageAction(commitForm()))).toBe("/admin/usage?done=recorded");
    expect(mocks.recordP6UsageCheck).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a stored draft: the second commit finds nothing", async () => {
    expect(await redirectUrl(actions.commitUsageAction(commitForm()))).toBe("/admin/usage?done=recorded");
    expect(mocks.clearP6Draft).toHaveBeenCalledTimes(1);
    mocks.readP6Draft.mockResolvedValue(null);
    expect(await redirectUrl(actions.commitUsageAction(commitForm()))).toBe("/admin/usage?error=draft_missing#input");
    expect(mocks.recordP6UsageCheck).toHaveBeenCalledTimes(1);
  });

  it("checks the version and validity before the draft, and the origin and admin before all", async () => {
    expect(await redirectUrl(actions.commitUsageAction(commitForm({ expectedVersion: "" })))).toBe("/admin/usage?step=confirm&error=stale#confirm");
    expect(mocks.readP6Draft).not.toHaveBeenCalled();
  });
});

describe("failure, stop, resume and void", () => {
  it("records a failure only with a known kind and the confirmation", async () => {
    expect(await redirectUrl(actions.failureAction(form({ kind: "because", confirmed: "on" })))).toBe("/admin/usage?error=invalid_input#failure");
    expect(await redirectUrl(actions.failureAction(form({ kind: "other" })))).toBe("/admin/usage?error=confirm_required#failure");
    expect(mocks.recordP6MonitoringFailure).not.toHaveBeenCalled();
    expect(await redirectUrl(actions.failureAction(form({ kind: "dashboard_unavailable", confirmed: "on" })))).toBe("/admin/usage?done=failure_recorded");
    expect(mocks.recordP6MonitoringFailure).toHaveBeenCalledWith(CLIENT, "dashboard_unavailable");
  });

  it("stops only with a known reason and the confirmation", async () => {
    expect(await redirectUrl(actions.stopAction(form({ reason: "other" })))).toBe("/admin/usage?error=confirm_required#stop");
    expect(mocks.stopP6).not.toHaveBeenCalled();
    expect(await redirectUrl(actions.stopAction(form({ reason: "usage_concern", confirmed: "on" })))).toBe("/admin/usage?done=stopped");
    expect(mocks.stopP6).toHaveBeenCalledWith(CLIENT, "usage_concern");
  });

  it("resumes one target with the page version and shows a refusal by its code", async () => {
    expect(await redirectUrl(actions.resumeAction(form({ target: "everything", expectedVersion: "3", confirmed: "on" })))).toBe(
      "/admin/usage?error=invalid_input#resume",
    );
    expect(await redirectUrl(actions.resumeAction(form({ target: "send", expectedVersion: "3" })))).toBe("/admin/usage?error=confirm_required#resume");
    expect(mocks.resumeP6).not.toHaveBeenCalled();

    expect(await redirectUrl(actions.resumeAction(form({ target: "registration", expectedVersion: "3", confirmed: "on" })))).toBe(
      "/admin/usage?done=resumed_registration",
    );
    expect(mocks.resumeP6).toHaveBeenCalledWith(CLIENT, { target: "registration", expectedVersion: 3 });

    mocks.resumeP6.mockResolvedValue({ ok: false, reason: "refused:second_check_missing" });
    expect(await redirectUrl(actions.resumeAction(form({ target: "send", expectedVersion: "3", confirmed: "on" })))).toBe(
      "/admin/usage?error=resume_refused&refusal=second_check_missing#resume",
    );
    mocks.resumeP6.mockResolvedValue({ ok: false, reason: "stale" });
    expect(await redirectUrl(actions.resumeAction(form({ target: "send", expectedVersion: "3", confirmed: "on" })))).toBe(
      "/admin/usage?error=stale#resume",
    );
  });

  it("voids only a well-formed check id with a known reason", async () => {
    expect(await redirectUrl(actions.voidAction(form({ checkId: "x", reason: "other", expectedVersion: "3", confirmed: "on" })))).toBe(
      "/admin/usage?error=invalid_input#history",
    );
    expect(await redirectUrl(actions.voidAction(form({ checkId: CHECK_ID, reason: "because", expectedVersion: "3", confirmed: "on" })))).toBe(
      "/admin/usage?error=invalid_input#history",
    );
    expect(mocks.voidP6UsageCheck).not.toHaveBeenCalled();
    expect(await redirectUrl(actions.voidAction(form({ checkId: CHECK_ID, reason: "input_error", expectedVersion: "3", confirmed: "on" })))).toBe(
      "/admin/usage?done=voided",
    );
    expect(mocks.voidP6UsageCheck).toHaveBeenCalledWith(CLIENT, { checkId: CHECK_ID, reason: "input_error", expectedVersion: 3 });
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class RedirectSentinel extends Error {
    constructor(public readonly url: string) {
      super(`NEXT_REDIRECT ${url}`);
    }
  }
  return {
    connection: vi.fn(),
    requireAdmin: vi.fn(),
    getP6Status: vi.fn(),
    previewP6UsageCheck: vi.fn(),
    readP6Draft: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new RedirectSentinel(url);
    }),
    REDIRECT: RedirectSentinel,
  };
});

vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth/admin-session", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/server/data/admin-usage-monitoring", () => ({
  getP6Status: mocks.getP6Status,
  previewP6UsageCheck: mocks.previewP6UsageCheck,
}));
// The cookie is mocked; the digest is the real one.
vi.mock("./draft-cookie", async (importOriginal) => ({
  readP6Draft: mocks.readP6Draft,
  p6DraftDigest: (await importOriginal<typeof import("./draft-cookie")>()).p6DraftDigest,
}));
// Each mocked Server Action renders as a distinct form URL.
vi.mock("./actions", () => {
  const action = (name: string) => Object.assign(vi.fn(), { $$FORM_ACTION: () => ({ action: `/__action/${name}`, name: null }) });
  return {
    previewUsageAction: action("preview"),
    commitUsageAction: action("commit"),
    discardDraftAction: action("discard"),
    failureAction: action("failure"),
    stopAction: action("stop"),
    resumeAction: action("resume"),
    voidAction: action("void"),
  };
});

const { default: AdminUsagePage } = await import("./page");
const { p6DraftDigest } = await import("./draft-cookie");

const FAKE_CLIENT = { user: { id: "00000000-0000-4000-8000-0000000000aa", email: "admin@example.invalid" } };
const CHECK_ID = "44444444-4444-4444-8444-444444444444";
const ENTERED = "123.456789";

const STATE = {
  evaluatedAt: "2026-11-07T05:30:00+00:00",
  registrationAllowed: false,
  tokenChangeAllowed: false,
  sendsAllowed: true,
  sendInGrace: true,
  registrationStopAt: "2026-11-07T05:00:00+00:00",
  registrationStopReason: "expired",
  sendStopAt: "2026-11-07T06:00:00+00:00",
  sendStopReason: "expired",
  monitoringIncidentAt: "2026-11-07T05:00:00+00:00",
  sendGraceUntil: "2026-11-07T06:00:00+00:00",
  registrationResumedAt: "2026-11-06T00:10:00+00:00",
  sendResumedAt: "2026-11-06T00:10:00+00:00",
  currentCheckId: CHECK_ID,
  registrationDeadline: "2026-11-07T05:00:00+00:00",
  sendDeadline: "2026-11-07T06:00:00+00:00",
  currentMaxLevel: 80,
  manualStopActive: false,
  version: 12,
};

const STATUS = {
  state: STATE,
  resumeRegistrationRefusal: "second_check_missing",
  resumeSendRefusal: null,
  checks: [
    {
      id: CHECK_ID,
      checkedAt: "2026-11-06T00:00:00+00:00",
      recordedAt: "2026-11-06T00:05:00+00:00",
      periodStart: "2026-11-02",
      periodEnd: "2026-12-02",
      spendCap: "on",
      dataAsOf: null,
      isValid: true,
      invalidReasons: [],
      voidedReason: null,
      voidedAt: null,
      values: [
        { metric: "egress", status: "measured", enteredValue: "200", enteredUnit: "GB", usage: "200", percent: "80.000", level: 80 },
        { metric: "storage_size", status: "unavailable", enteredValue: null, enteredUnit: null, usage: null, percent: null, level: null },
      ],
    },
  ],
  failures: [],
  manualStops: [],
  warnings: [{ id: "w1", createdAt: "2026-11-06T00:05:00+00:00", kind: "usage", level: 80, metric: "egress", periodStart: "2026-11-02" }],
};

const DRAFT = { checkedAt: "2026-11-07T14:20", periodStart: "2026-11-02", periodEnd: "2026-12-02", spendCap: "on", "egress.value": ENTERED, "egress.unit": "MB" };

function props(params: Record<string, string | string[] | undefined> = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(params) };
}

async function render(params: Record<string, string | string[] | undefined> = {}) {
  return renderToStaticMarkup(await AdminUsagePage(props(params)));
}

beforeEach(() => {
  mocks.connection.mockResolvedValue(undefined);
  mocks.requireAdmin.mockResolvedValue(FAKE_CLIENT);
  mocks.getP6Status.mockResolvedValue(STATUS);
  mocks.readP6Draft.mockResolvedValue(null);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [mocks.connection, mocks.requireAdmin, mocks.getP6Status, mocks.previewP6UsageCheck, mocks.readP6Draft]) {
    mock.mockReset();
  }
});

describe("AdminUsagePage access", () => {
  it("requires an admin before reading anything", async () => {
    const order: string[] = [];
    mocks.connection.mockImplementation(async () => void order.push("connection"));
    mocks.requireAdmin.mockImplementation(async () => {
      order.push("requireAdmin");
      return FAKE_CLIENT;
    });
    mocks.getP6Status.mockImplementation(async () => {
      order.push("status");
      return STATUS;
    });
    await render();
    expect(order).toEqual(["connection", "requireAdmin", "status"]);
    expect(mocks.getP6Status.mock.calls[0][0]).toBe(FAKE_CLIENT);
  });

  it("reads nothing for visitors who are not admins", async () => {
    mocks.requireAdmin.mockImplementation(() => mocks.redirect("/admin/login"));
    await expect(AdminUsagePage(props())).rejects.toMatchObject({ url: "/admin/login" });
    expect(mocks.getP6Status).not.toHaveBeenCalled();
    expect(mocks.readP6Draft).not.toHaveBeenCalled();
  });

  it("never shows the admin identity", async () => {
    const html = await render();
    expect(html).not.toContain("admin@example.invalid");
    expect(html).not.toContain(FAKE_CLIENT.user.id);
  });
});

describe("AdminUsagePage state", () => {
  it("says the state is not connected to registration or sending yet", async () => {
    expect(await render()).toContain('data-not-connected="true"');
  });

  it("separates registrations, token changes and sending, and shows the grace hour", async () => {
    const html = await render();
    expect(html).toMatch(/新規登録<\/span><span data-state="stop"/);
    expect(html).toMatch(/Token変更の確認<\/span><span data-state="stop"/);
    expect(html).toMatch(/既存Pushの送信<\/span><span data-state="grace"/);
    expect(html).toContain("2026/11/7 15:00（日本時間） まで（最長1時間）の猶予中です。猶予は延長されません。");
    expect(html).toContain("理由：確認期限切れ");
  });

  it("shows the dashboard time and the recording time separately", async () => {
    const html = await render();
    expect(html).toContain("公式画面の確認時刻</dt><dd>2026/11/6 09:00（日本時間）");
    expect(html).toContain("管理画面への登録時刻</dt><dd>2026/11/6 09:05（日本時間）");
    expect(html).toContain("データの対象時刻</dt><dd>表示なし");
  });

  it("shows each level in words, and an unreadable metric as unknown (not 0%)", async () => {
    const html = await render();
    expect(html).toContain('data-level="80"');
    expect(html).toContain("80%以上：警告");
    expect(html).toContain("使用量 200 GB ／ 上限 250 GB");
    expect(html).toContain("未取得（0%とは扱いません）");
  });

  it("offers a resume form only where the database allows it", async () => {
    const html = await render();
    expect(html).toContain('data-resume="send"');
    expect(html).not.toContain('data-resume="registration"');
    expect(html).toContain('data-resume-refusal="registration"');
    expect(html).toContain("停止後に24時間以上空けた2回の有効な確認がありません");
  });

  it("guards stop, resume, failure and void with a required confirmation", async () => {
    const html = await render();
    for (const action of ["stop", "resume", "failure", "void"]) {
      const start = html.indexOf(`action="/__action/${action}"`);
      expect(start, action).toBeGreaterThan(-1);
      const formHtml = html.slice(start, html.indexOf("</form>", start));
      expect(formHtml, action).toMatch(/<input type="checkbox"(?=[^>]*required="")(?=[^>]*name="confirmed")[^>]*\/>/);
    }
  });

  it("shows a load failure without details", async () => {
    mocks.getP6Status.mockRejectedValue(new Error("SECRET detail"));
    const html = await render();
    expect(html).toContain("使用量の状態を読み込めませんでした");
    expect(html).not.toContain("SECRET");
  });
});

describe("AdminUsagePage input form (mobile)", () => {
  it("has one fieldset per metric, decimal keyboards for bytes and numeric keyboards for counts", async () => {
    const html = await render();
    expect(html.match(/data-metric-input="/g)).toHaveLength(11);
    expect(html.match(/inputMode="decimal"/g)).toHaveLength(7 * 2);
    expect(html.match(/inputMode="numeric"/g)).toHaveLength(4 * 2);
    expect(html).not.toContain('type="number"');
  });

  it("offers a unit choice only for byte metrics", async () => {
    const html = await render();
    expect(html.match(/name="[a-z_]+\.unit"/g)).toHaveLength(7);
    expect(html).not.toContain('name="monthly_active_users.unit"');
    expect(html).toContain('<option value="MB">MB</option>');
  });

  it("separates organization usage from the per-project disks and shows the quotas", async () => {
    const html = await render();
    expect(html).toContain("組織全体の使用量（Organization）");
    expect(html).toContain("プロジェクトごとの Disk（合計しません）");
    expect(html).toContain("Pro の上限 8 GB（Pro: 8 GB GP3 disk per project）");
    expect(html).toContain("期間平均の値です。現在の容量ではありません。");
  });

  it("uses 16px inputs in a narrow single column", async () => {
    const html = await render();
    expect(html).toContain('<main class="mx-auto flex w-full max-w-md flex-1 flex-col gap-4 px-4 pb-12 pt-6">');
    expect(html).toMatch(/<input(?=[^>]*name="egress\.value")(?=[^>]*class="rounded-xl border border-black\/10 px-3 py-2 text-base)[^>]*\/>/);
  });

  it("posts the form to the preview action (never GET)", async () => {
    const html = await render();
    expect(html).toContain('action="/__action/preview"');
    expect(html).not.toMatch(/method="get"/i);
  });

  it("asks for an explicit choice per metric: two radios each, none chosen in advance, required", async () => {
    const html = await render();
    for (const code of ["egress", "storage_size", "monthly_active_users", "disk_size_production"]) {
      expect(html).toMatch(new RegExp(`<input(?=[^>]*type="radio")(?=[^>]*name="${code}\\.status")(?=[^>]*value="measured")(?=[^>]*required="")[^>]*/>`));
      expect(html).toMatch(new RegExp(`<input(?=[^>]*type="radio")(?=[^>]*name="${code}\\.status")(?=[^>]*value="unavailable")[^>]*/>`));
    }
    expect(html.match(/name="[a-z_]+\.status" value="measured"/g)).toHaveLength(11);
    expect(html.match(/name="[a-z_]+\.status" value="unavailable"/g)).toHaveLength(11);
    expect(html).not.toMatch(/type="radio"[^>]*checked=""/);
    expect(html).not.toContain('type="checkbox" name="storage_size.unavailable"');
  });

  it("explains a normal 0 against \"取得できなかった\", with the Storage example, and the safe side when unsure", async () => {
    const html = await render();
    expect(html).toContain('data-value-status-guide="true"');
    expect(html).toContain("0 と表示されていれば、正常な 0 として入力します");
    expect(html).toContain("No data しか確認できない");
    expect(html).toContain("Average in period: 0.00 GB");
    expect(html).toContain("集計欄の 0.00 GB が誤りとは言えません");
    expect(html).toContain("0.00 GB は、元のデータが新しいことの保証ではありません");
    expect(html).toContain("判断できないときは「取得できなかった」を選んでください（安全側です）");
  });

  it("tells the admin to leave the data time empty unless the dashboard shows one", async () => {
    const html = await render();
    expect(html).toContain("表示されていない場合は空欄にし、推測で入力しないでください");
    expect(html).toContain("確認時刻より24時間以上前の時刻は、古すぎるため無効な確認になります");
  });

  it("refills the chosen status from the draft cookie", async () => {
    mocks.readP6Draft.mockResolvedValue({ ...DRAFT, "egress.status": "measured", "storage_size.status": "unavailable" });
    const html = await render();
    expect(html).toMatch(/<input(?=[^>]*name="egress\.status")(?=[^>]*value="measured")(?=[^>]*checked="")[^>]*\/>/);
    expect(html).toMatch(/<input(?=[^>]*name="storage_size\.status")(?=[^>]*value="unavailable")(?=[^>]*checked="")[^>]*\/>/);
    expect(html).not.toMatch(/<input(?=[^>]*name="cached_egress\.status")(?=[^>]*checked="")[^>]*\/>/);
  });

  it("refills the form from the draft cookie", async () => {
    mocks.readP6Draft.mockResolvedValue(DRAFT);
    const html = await render();
    expect(html).toContain(`value="${ENTERED}"`);
    expect(html).toMatch(/<option value="MB" selected="">MB<\/option>/);
  });

  it("shows only known error codes, never query text", async () => {
    expect(await render({ error: "value" })).toContain("「数値を確認できた」を選んだ項目には、使用量と上限を正しく入力してください");
    expect(await render({ error: "status" })).toContain("すべての項目で「数値を確認できた」か「取得できなかった」を選んでください");
    expect(await render({ error: "status_value" })).toContain("「取得できなかった」を選んだ項目には、使用量と上限を入力しないでください");
    const html = await render({ error: "<script>x</script>", done: "<b>" });
    expect(html).not.toContain("<script>x");
    expect(html).not.toContain("<b>");
    expect(await render({ error: "resume_refused", refusal: "usage_too_high" })).toContain("再開の条件を満たしていません：確認の使用率が停止の閾値以上です");
  });
});

describe("AdminUsagePage confirmation step", () => {
  const PREVIEW = {
    valid: false,
    reasons: ["spend_cap_not_on"],
    values: [{ metric: "egress", status: "measured", enteredValue: ENTERED, enteredUnit: "MB", usage: "0.123456789", percent: "0.049", level: 0, quota: "250", enteredQuota: "250" }],
    evaluatedAt: "2026-11-07T05:30:00+00:00",
    version: 12,
  };

  const CONFIRM_DRAFT = {
      ...DRAFT,
      ...Object.fromEntries(
        ["cached_egress", "storage_size", "log_ingestion", "log_query", "disk_size_preview", "disk_size_production"].flatMap((code) => [
          [`${code}.value`, "0"],
          [`${code}.unit`, "GB"],
          [`${code}.quota`, { cached_egress: "250", storage_size: "100", log_ingestion: "20", log_query: "2000", disk_size_preview: "8", disk_size_production: "8" }[code]],
        ]),
      ),
      "egress.quota": "250",
      "edge_function_invocations.value": "0",
      "edge_function_invocations.quota": "2000000",
      "monthly_active_users.value": "4",
      "monthly_active_users.quota": "100000",
      "realtime_messages.value": "0",
      "realtime_messages.quota": "5000000",
      "realtime_peak_connections.value": "0",
      "realtime_peak_connections.quota": "500",
    ...Object.fromEntries(
      ["egress", "cached_egress", "edge_function_invocations", "monthly_active_users", "storage_size", "realtime_messages", "realtime_peak_connections", "log_ingestion", "log_query", "disk_size_preview", "disk_size_production"].map(
        (code) => [`${code}.status`, "measured"],
      ),
    ),
  };

  it("validates the draft without storing and asks for confirmation", async () => {
    mocks.readP6Draft.mockResolvedValue(CONFIRM_DRAFT);
    mocks.previewP6UsageCheck.mockResolvedValue({ ok: true, preview: PREVIEW });

    const html = await render({ step: "confirm" });

    expect(mocks.previewP6UsageCheck).toHaveBeenCalledTimes(1);
    expect(html).toContain("入力内容の確認（まだ保存されていません）");
    expect(html).toContain('data-preview-valid="false"');
    expect(html).toContain("Spend Cap が有効ではありません");
    expect(html).toContain("入力：123.456789 MB → 0.123456789 GB");
    expect(html).toContain("管理画面への登録時刻</dt><dd>保存したときにデータベースが記録します");
    expect(html).toContain('action="/__action/commit"');
    expect(html).toContain('<input type="hidden" name="expectedVersion" value="12"/>');
    expect(html).toContain('<input type="hidden" name="expectedValid" value="false"/>');
    expect(html).not.toContain('action="/__action/preview"');
    // Links never carry the entered numbers.
    for (const [, href] of html.matchAll(/href="([^"]*)"/g)) expect(href).not.toContain(ENTERED);
  });

  it("ties the confirmation to the draft shown, by its digest only (no numbers in the form)", async () => {
    mocks.readP6Draft.mockResolvedValue(CONFIRM_DRAFT);
    mocks.previewP6UsageCheck.mockResolvedValue({ ok: true, preview: PREVIEW });
    const html = await render({ step: "confirm" });
    const commitForm = html.slice(html.indexOf('action="/__action/commit"'));
    expect(commitForm).toContain(`<input type="hidden" name="draftDigest" value="${p6DraftDigest(CONFIRM_DRAFT)}"/>`);
    expect(commitForm.slice(0, commitForm.indexOf("</form>"))).not.toContain(ENTERED);
  });

  it("asks for a new confirmation when the draft changed, and explains a draft too large", async () => {
    mocks.readP6Draft.mockResolvedValue(CONFIRM_DRAFT);
    mocks.previewP6UsageCheck.mockResolvedValue({ ok: true, preview: PREVIEW });
    const changed = await render({ step: "confirm", error: "draft_changed" });
    expect(changed).toContain("確認した後に入力内容が変わりました");
    expect(changed).toContain("保存していません");
    expect(changed).toContain('action="/__action/commit"');

    mocks.readP6Draft.mockResolvedValue(null);
    const tooLarge = await render({ error: "draft_too_large" });
    expect(tooLarge).toContain("入力内容が長すぎるため保存できませんでした（以前の入力も破棄しました）");
    expect(tooLarge).not.toContain('action="/__action/commit"');
  });

  it("warns about every metric that will be stored as 0", async () => {
    mocks.readP6Draft.mockResolvedValue(CONFIRM_DRAFT);
    mocks.previewP6UsageCheck.mockResolvedValue({
      ok: true,
      preview: {
        ...PREVIEW,
        values: [
          PREVIEW.values[0],
          { metric: "storage_size", status: "measured", enteredValue: "0.00", enteredUnit: "GB", usage: "0.00", percent: "0.000", level: 0, quota: "100", enteredQuota: "100" },
          { metric: "monthly_active_users", status: "measured", enteredValue: "0", enteredUnit: "count", usage: "0", percent: "0.000", level: 0, quota: "100000", enteredQuota: "100000" },
          { metric: "cached_egress", status: "unavailable", enteredValue: null, enteredUnit: null, usage: null, percent: null, level: null, quota: null, enteredQuota: null },
        ],
      },
    });
    const html = await render({ step: "confirm" });
    expect(html).toContain('data-zero-notice="true"');
    expect(html).toContain("次の項目は 0 として保存されます：Storage Size");
    expect(html).toContain("Monthly Active Users");
    expect(html.slice(html.indexOf('data-zero-notice="true"'), html.indexOf("</div>", html.indexOf('data-zero-notice="true"')))).not.toContain("Cached Egress");
    expect(html).toContain("入力に戻って「取得できなかった」を選んでください");
  });

  it("shows no 0 notice when nothing is 0, and no new-period notice within the same period", async () => {
    mocks.readP6Draft.mockResolvedValue(CONFIRM_DRAFT);
    mocks.previewP6UsageCheck.mockResolvedValue({ ok: true, preview: PREVIEW });
    const html = await render({ step: "confirm" });
    expect(html).not.toContain("data-zero-notice");
    expect(html).not.toContain("data-new-period-notice");
  });

  it("marks the first check of a new billing period, against the newest valid check on record", async () => {
    mocks.readP6Draft.mockResolvedValue({ ...CONFIRM_DRAFT, periodStart: "2026-12-02", periodEnd: "2027-01-02" });
    mocks.previewP6UsageCheck.mockResolvedValue({ ok: true, preview: PREVIEW });
    const html = await render({ step: "confirm" });
    expect(html).toContain('data-new-period-notice="first"');
    expect(html).toContain("この請求期間で最初の確認です。");
    expect(html).toContain("公式画面の数値がまだ反映されていないことがあります");
  });

  it("ignores voided and invalid checks when deciding the period, and says so when it cannot tell", async () => {
    mocks.readP6Draft.mockResolvedValue(CONFIRM_DRAFT);
    mocks.previewP6UsageCheck.mockResolvedValue({ ok: true, preview: PREVIEW });
    mocks.getP6Status.mockResolvedValue({
      ...STATUS,
      checks: [
        { ...STATUS.checks[0], id: "a", isValid: false, invalidReasons: ["data_too_old"] },
        { ...STATUS.checks[0], id: "b", voidedAt: "2026-11-06T01:00:00+00:00", voidedReason: "input_error" },
      ],
    });
    expect(await render({ step: "confirm" })).toContain('data-new-period-notice="unknown"');
    mocks.getP6Status.mockRejectedValue(new Error("down"));
    expect(await render({ step: "confirm" })).toContain('data-new-period-notice="unknown"');
  });

  it("explains data_too_old when the database finds the data time too old", async () => {
    mocks.readP6Draft.mockResolvedValue(CONFIRM_DRAFT);
    mocks.previewP6UsageCheck.mockResolvedValue({ ok: true, preview: { ...PREVIEW, reasons: ["data_too_old"] } });
    const html = await render({ step: "confirm" });
    expect(html).toContain("データの対象時刻が古すぎます（公式画面の確認時刻より24時間以上前）");
    expect(html).toContain('<input type="hidden" name="expectedValid" value="false"/>');
  });

  it("falls back to the form when there is no draft", async () => {
    const html = await render({ step: "confirm" });
    expect(mocks.previewP6UsageCheck).not.toHaveBeenCalled();
    expect(html).toContain('action="/__action/preview"');
  });
});

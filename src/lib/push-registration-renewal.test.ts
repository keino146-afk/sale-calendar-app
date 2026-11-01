import { describe, expect, it } from "vitest";
import { parseInstantMicros } from "./push-notification-schedule";
import {
  decidePushRegistrationRenewal,
  PUSH_REGISTRATION_LIFETIME_US,
  PUSH_REGISTRATION_RENEWAL_WINDOW_US,
  type PushRegistrationRenewalClaim,
  type PushRegistrationRenewalDecision,
  type PushRegistrationState,
} from "./push-registration-renewal";

const HOUR_US = 60 * 60 * 1000 * 1000;
const DAY_US = 24 * HOUR_US;
const NOW_US = parseInstantMicros("2026-11-01T10:00:00+09:00")!;

// An active registration with 30 days left, and a claim that matches it.
const REGISTRATION: PushRegistrationState = {
  status: "active",
  expiresAtUs: NOW_US + 30 * DAY_US,
  notificationsEnabled: true,
  sendPaused: false,
  tokenHash: "token-hash-a",
  confirmedTokenGeneration: 3,
};

const CLAIM: PushRegistrationRenewalClaim = {
  tokenHash: "token-hash-a",
  tokenGeneration: 3,
  osPermissionGranted: true,
  deviceCheckPassed: true,
};

function decide(
  registration: Partial<PushRegistrationState> = {},
  claim: Partial<PushRegistrationRenewalClaim> = {},
  nowUs = NOW_US,
): PushRegistrationRenewalDecision {
  return decidePushRegistrationRenewal({ ...REGISTRATION, ...registration }, { ...CLAIM, ...claim }, nowUs);
}

// Inputs that do not match the types, as they could arrive at runtime.
function decideUnchecked(registration: unknown, claim: unknown, nowUs: unknown): PushRegistrationRenewalDecision {
  return decidePushRegistrationRenewal(
    registration as PushRegistrationState,
    claim as PushRegistrationRenewalClaim,
    nowUs as number,
  );
}

function withoutKey<T extends object>(value: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...value };
  delete copy[key];
  return copy;
}

const RENEWED = { ok: true, action: "renew", newExpiresAtUs: NOW_US + 90 * DAY_US };

describe("push registration renewal constants", () => {
  it("are 90 and 45 times 24 hours, in microseconds", () => {
    expect(PUSH_REGISTRATION_LIFETIME_US).toBe(90 * 24 * HOUR_US);
    expect(PUSH_REGISTRATION_RENEWAL_WINDOW_US).toBe(45 * 24 * HOUR_US);
  });
});

describe("decidePushRegistrationRenewal timing", () => {
  it("does not renew with 46 days left", () => {
    expect(decide({ expiresAtUs: NOW_US + 46 * DAY_US })).toEqual({
      ok: true,
      action: "not-due",
      expiresAtUs: NOW_US + 46 * DAY_US,
    });
  });

  it("renews with exactly 45 days left", () => {
    expect(decide({ expiresAtUs: NOW_US + 45 * DAY_US })).toEqual(RENEWED);
  });

  it("does not renew with 45 days and 1 µs left", () => {
    expect(decide({ expiresAtUs: NOW_US + 45 * DAY_US + 1 })).toEqual({
      ok: true,
      action: "not-due",
      expiresAtUs: NOW_US + 45 * DAY_US + 1,
    });
  });

  it("renews with 1 day left, and with 1 µs left", () => {
    expect(decide({ expiresAtUs: NOW_US + DAY_US })).toEqual(RENEWED);
    expect(decide({ expiresAtUs: NOW_US + 1 })).toEqual(RENEWED);
  });

  it("treats the expiry instant itself as expired", () => {
    expect(decide({ expiresAtUs: NOW_US })).toEqual({ ok: false, reason: "expired" });
  });

  it("treats 1 µs past the expiry as expired", () => {
    expect(decide({ expiresAtUs: NOW_US - 1 })).toEqual({ ok: false, reason: "expired" });
  });

  it("never renews a registration that expired long ago", () => {
    expect(decide({ expiresAtUs: NOW_US - 365 * DAY_US })).toEqual({ ok: false, reason: "expired" });
  });

  it("sets the new expiry to nowUs + 90 × 24 hours, not from the old expiry", () => {
    const nowUs = NOW_US + 123_456;
    const result = decide({ expiresAtUs: nowUs + 10 * DAY_US + 7 }, {}, nowUs);

    expect(result).toEqual({ ok: true, action: "renew", newExpiresAtUs: nowUs + 90 * 24 * HOUR_US });
  });
});

describe("decidePushRegistrationRenewal refusals", () => {
  it("refuses when notifications are switched off", () => {
    expect(decide({ notificationsEnabled: false })).toEqual({ ok: false, reason: "notifications-off" });
  });

  it("refuses a disabled registration", () => {
    expect(decide({ status: "disabled" })).toEqual({ ok: false, reason: "disabled" });
  });

  it("refuses while sending is paused for a token change (B3)", () => {
    expect(decide({ sendPaused: true })).toEqual({ ok: false, reason: "send-paused" });
  });

  it("refuses when the claimed token is not the registration's", () => {
    expect(decide({}, { tokenHash: "token-hash-b" })).toEqual({ ok: false, reason: "token-mismatch" });
  });

  it("refuses when the claimed token generation is not the confirmed one, older or newer", () => {
    expect(decide({}, { tokenGeneration: 2 })).toEqual({ ok: false, reason: "generation-mismatch" });
    expect(decide({}, { tokenGeneration: 4 })).toEqual({ ok: false, reason: "generation-mismatch" });
  });

  it("refuses without OS notification permission", () => {
    expect(decide({}, { osPermissionGranted: false })).toEqual({ ok: false, reason: "os-permission-not-granted" });
  });

  it("refuses when the OS permission is not reported or not exactly true", () => {
    for (const value of [undefined, null, "true", 1]) {
      expect(decideUnchecked(REGISTRATION, { ...CLAIM, osPermissionGranted: value }, NOW_US)).toEqual({
        ok: false,
        reason: "os-permission-not-granted",
      });
    }
    expect(decideUnchecked(REGISTRATION, withoutKey(CLAIM, "osPermissionGranted"), NOW_US)).toEqual({
      ok: false,
      reason: "os-permission-not-granted",
    });
  });

  it("refuses when the device check failed", () => {
    expect(decide({}, { deviceCheckPassed: false })).toEqual({ ok: false, reason: "device-check-failed" });
  });

  it("refuses when the device check is not reported or not exactly true", () => {
    for (const value of [undefined, null, "true", 1]) {
      expect(decideUnchecked(REGISTRATION, { ...CLAIM, deviceCheckPassed: value }, NOW_US)).toEqual({
        ok: false,
        reason: "device-check-failed",
      });
    }
    expect(decideUnchecked(REGISTRATION, withoutKey(CLAIM, "deviceCheckPassed"), NOW_US)).toEqual({
      ok: false,
      reason: "device-check-failed",
    });
  });
});

describe("decidePushRegistrationRenewal invalid input", () => {
  const INVALID = { ok: false, reason: "invalid-input" };

  it("rejects a missing required field of the registration or the claim", () => {
    for (const key of Object.keys(REGISTRATION) as (keyof PushRegistrationState)[]) {
      expect(decideUnchecked(withoutKey(REGISTRATION, key), CLAIM, NOW_US)).toEqual(INVALID);
    }
    for (const key of ["tokenHash", "tokenGeneration"] as const) {
      expect(decideUnchecked(REGISTRATION, withoutKey(CLAIM, key), NOW_US)).toEqual(INVALID);
    }
  });

  it("rejects a missing registration, claim or now", () => {
    expect(decideUnchecked(null, CLAIM, NOW_US)).toEqual(INVALID);
    expect(decideUnchecked(REGISTRATION, undefined, NOW_US)).toEqual(INVALID);
    expect(decideUnchecked(REGISTRATION, CLAIM, undefined)).toEqual(INVALID);
  });

  it("rejects a time that is not a safe integer number of microseconds", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, "0", Number.MAX_SAFE_INTEGER + 1]) {
      expect(decideUnchecked(REGISTRATION, CLAIM, value)).toEqual(INVALID);
      expect(decideUnchecked({ ...REGISTRATION, expiresAtUs: value }, CLAIM, NOW_US)).toEqual(INVALID);
    }
  });

  it("rejects a token generation that is not a positive safe integer", () => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", Number.MAX_SAFE_INTEGER + 1]) {
      expect(decideUnchecked({ ...REGISTRATION, confirmedTokenGeneration: value }, CLAIM, NOW_US)).toEqual(INVALID);
      expect(decideUnchecked(REGISTRATION, { ...CLAIM, tokenGeneration: value }, NOW_US)).toEqual(INVALID);
    }
  });

  it("rejects an unknown status, non-boolean flags and empty or non-string token hashes", () => {
    expect(decideUnchecked({ ...REGISTRATION, status: "expired" }, CLAIM, NOW_US)).toEqual(INVALID);
    expect(decideUnchecked({ ...REGISTRATION, notificationsEnabled: "true" }, CLAIM, NOW_US)).toEqual(INVALID);
    expect(decideUnchecked({ ...REGISTRATION, sendPaused: 0 }, CLAIM, NOW_US)).toEqual(INVALID);
    expect(decideUnchecked({ ...REGISTRATION, tokenHash: "" }, CLAIM, NOW_US)).toEqual(INVALID);
    expect(decideUnchecked(REGISTRATION, { ...CLAIM, tokenHash: 42 }, NOW_US)).toEqual(INVALID);
  });

  it("rejects a now whose new expiry would not be a safe integer, even when not due", () => {
    const nowUs = Number.MAX_SAFE_INTEGER - PUSH_REGISTRATION_LIFETIME_US + 1;

    expect(decide({ expiresAtUs: nowUs + DAY_US }, {}, nowUs)).toEqual(INVALID);
    expect(decide({ expiresAtUs: Number.MAX_SAFE_INTEGER }, {}, nowUs)).toEqual(INVALID);
    // One microsecond earlier the new expiry is exactly the largest safe integer.
    expect(decide({ expiresAtUs: nowUs }, {}, nowUs - 1)).toEqual({
      ok: true,
      action: "renew",
      newExpiresAtUs: Number.MAX_SAFE_INTEGER,
    });
  });
});

describe("decidePushRegistrationRenewal safety", () => {
  it("does not change its inputs", () => {
    const registration = { ...REGISTRATION, expiresAtUs: NOW_US + DAY_US };
    const claim = { ...CLAIM };
    const before = JSON.stringify([registration, claim]);

    decidePushRegistrationRenewal(Object.freeze(registration), Object.freeze(claim), NOW_US);

    expect(JSON.stringify([registration, claim])).toBe(before);
  });

  it("never turns a disabled or expired registration back on, whatever the claim says", () => {
    const claims = [CLAIM, { ...CLAIM, tokenGeneration: 4 }, { ...CLAIM, osPermissionGranted: false }];
    for (const claim of claims) {
      for (const notificationsEnabled of [true, false]) {
        const disabled = decide({ status: "disabled", notificationsEnabled }, claim);
        const expired = decide({ expiresAtUs: NOW_US - DAY_US, notificationsEnabled }, claim);

        expect(disabled).toEqual({ ok: false, reason: "disabled" });
        expect(expired).toEqual({ ok: false, reason: "expired" });
      }
    }
  });

  it("returns only a decision, never a status or anything to write", () => {
    expect(Object.keys(decide({ expiresAtUs: NOW_US + DAY_US })).sort()).toEqual(["action", "newExpiresAtUs", "ok"]);
    expect(Object.keys(decide()).sort()).toEqual(["action", "newExpiresAtUs", "ok"]);
    expect(Object.keys(decide({ expiresAtUs: NOW_US + 60 * DAY_US })).sort()).toEqual(["action", "expiresAtUs", "ok"]);
    expect(Object.keys(decide({ status: "disabled" })).sort()).toEqual(["ok", "reason"]);
  });

  // Only the rule is tested here. Authorizing the request (the registration
  // secret), locking the row and the atomic update are the server's job, and
  // nowUs coming from the server's clock cannot be checked by this function.
  it("lets a claim that matches in every way not override the server's state", () => {
    expect(decide({ notificationsEnabled: false })).toEqual({ ok: false, reason: "notifications-off" });
    expect(decide({ sendPaused: true })).toEqual({ ok: false, reason: "send-paused" });
    expect(decide({ tokenHash: "token-hash-b" })).toEqual({ ok: false, reason: "token-mismatch" });
    expect(decide({ confirmedTokenGeneration: 4 })).toEqual({ ok: false, reason: "generation-mismatch" });
  });

  it("returns the first refusal in a fixed order when several apply", () => {
    const allWrong: [Partial<PushRegistrationState>, Partial<PushRegistrationRenewalClaim>] = [
      { status: "disabled", expiresAtUs: NOW_US, notificationsEnabled: false, sendPaused: true },
      { tokenHash: "token-hash-b", tokenGeneration: 4, osPermissionGranted: false, deviceCheckPassed: false },
    ];
    const fixes: [Partial<PushRegistrationState>, Partial<PushRegistrationRenewalClaim>][] = [
      [{ status: "active" }, {}],
      [{ expiresAtUs: NOW_US + DAY_US }, {}],
      [{ notificationsEnabled: true }, {}],
      [{ sendPaused: false }, {}],
      [{}, { tokenHash: "token-hash-a" }],
      [{}, { tokenGeneration: 3 }],
      [{}, { osPermissionGranted: true }],
      [{}, { deviceCheckPassed: true }],
    ];
    const reasons = [
      "disabled",
      "expired",
      "notifications-off",
      "send-paused",
      "token-mismatch",
      "generation-mismatch",
      "os-permission-not-granted",
      "device-check-failed",
    ];

    let [registration, claim] = allWrong;
    reasons.forEach((reason, i) => {
      expect(decide(registration, claim)).toEqual({ ok: false, reason });
      registration = { ...registration, ...fixes[i][0] };
      claim = { ...claim, ...fixes[i][1] };
    });
    expect(decide(registration, claim)).toEqual(RENEWED);
    // Invalid input comes before every refusal.
    expect(decide({ ...allWrong[0], confirmedTokenGeneration: 0 }, allWrong[1])).toEqual({
      ok: false,
      reason: "invalid-input",
    });
  });
});

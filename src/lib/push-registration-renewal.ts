import { DAY_MS } from "./jst";

// Whether a device registration for automatic pushes meets the conditions for
// having its expiry extended, and the new expiry if so. Pure: no clock (now is
// always passed in), no database, no network, no state change. Times are
// microseconds since the Unix epoch as safe integers, as in
// push-notification-schedule.
//
// This is the executable reference for the rules that the server (SQL) and
// the app (Native) are to follow, not the server check itself. A "renew"
// result only says that the conditions given here hold; it does not authorize
// anything and must not be used as permission to extend a registration. In
// particular this module does not, and cannot:
// - authorize the request (the registration secret is checked by the server,
//   which also locks the row and updates it atomically),
// - know where nowUs came from (the real check must use the server's clock),
// - confirm that a push token receives pushes,
// - trust the claim: everything in it is reported by the device. A claimed
//   token or generation that matches is necessary, not proof; the OS
//   permission and the device check (secure secret and install marker) can
//   only be reported by the device, so anything but true refuses.
//
// It never returns a state change, so an expired, switched-off or disabled
// registration is never turned back on here. Whether confirming a new token
// after a B3 pause also extends the expiry is not decided here.

const DAY_US = DAY_MS * 1000;

// A registration expires 90 × 24 hours after its last renewal, at the
// server's time; it is due for renewal once at most 45 × 24 hours remain.
export const PUSH_REGISTRATION_LIFETIME_US = 90 * DAY_US;
export const PUSH_REGISTRATION_RENEWAL_WINDOW_US = 45 * DAY_US;

export type PushRegistrationStatus = "active" | "disabled";

// As stored on the server.
export type PushRegistrationState = {
  status: PushRegistrationStatus;
  // Exclusive: at expiresAtUs the registration has expired.
  expiresAtUs: number;
  notificationsEnabled: boolean;
  // Sending paused until a new token is confirmed (B3).
  sendPaused: boolean;
  tokenHash: string;
  confirmedTokenGeneration: number;
};

// As reported by the device. Not trusted.
export type PushRegistrationRenewalClaim = {
  tokenHash: string;
  tokenGeneration: number;
  osPermissionGranted: boolean;
  deviceCheckPassed: boolean;
};

// In the order they are checked: the first that applies is returned.
export type PushRegistrationRenewalRefusal =
  | "invalid-input"
  | "disabled"
  | "expired"
  | "notifications-off"
  | "send-paused"
  | "token-mismatch"
  | "generation-mismatch"
  | "os-permission-not-granted"
  | "device-check-failed";

export type PushRegistrationRenewalDecision =
  // The conditions hold and at most 45 days remain: the expiry would become
  // newExpiresAtUs (nowUs + 90 days). Not an authorization.
  | { ok: true; action: "renew"; newExpiresAtUs: number }
  // The conditions hold but more than 45 days remain: nothing to change.
  | { ok: true; action: "not-due"; expiresAtUs: number }
  | { ok: false; reason: PushRegistrationRenewalRefusal };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function isTokenHash(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

// Everything the decision reads, with the types it must have. The claim's
// osPermissionGranted and deviceCheckPassed are not checked here: anything
// but true refuses them below.
function isValidInput(registration: unknown, claim: unknown, nowUs: unknown): boolean {
  if (!isRecord(registration) || !isRecord(claim)) return false;
  if (!Number.isSafeInteger(nowUs) || !Number.isSafeInteger(registration.expiresAtUs)) return false;
  // The new expiry must be a safe integer too, whether or not it is needed.
  if (!Number.isSafeInteger((nowUs as number) + PUSH_REGISTRATION_LIFETIME_US)) return false;
  if (registration.status !== "active" && registration.status !== "disabled") return false;
  if (typeof registration.notificationsEnabled !== "boolean" || typeof registration.sendPaused !== "boolean") {
    return false;
  }
  if (!isTokenHash(registration.tokenHash) || !isTokenHash(claim.tokenHash)) return false;
  return isGeneration(registration.confirmedTokenGeneration) && isGeneration(claim.tokenGeneration);
}

export function decidePushRegistrationRenewal(
  registration: PushRegistrationState,
  claim: PushRegistrationRenewalClaim,
  nowUs: number,
): PushRegistrationRenewalDecision {
  if (!isValidInput(registration, claim, nowUs)) return { ok: false, reason: "invalid-input" };

  if (registration.status !== "active") return { ok: false, reason: "disabled" };
  if (nowUs >= registration.expiresAtUs) return { ok: false, reason: "expired" };
  if (!registration.notificationsEnabled) return { ok: false, reason: "notifications-off" };
  if (registration.sendPaused) return { ok: false, reason: "send-paused" };
  // A plain comparison: this is the reference rule, not the server's
  // constant-time check.
  if (claim.tokenHash !== registration.tokenHash) return { ok: false, reason: "token-mismatch" };
  if (claim.tokenGeneration !== registration.confirmedTokenGeneration) {
    return { ok: false, reason: "generation-mismatch" };
  }
  if (claim.osPermissionGranted !== true) return { ok: false, reason: "os-permission-not-granted" };
  if (claim.deviceCheckPassed !== true) return { ok: false, reason: "device-check-failed" };

  if (registration.expiresAtUs - nowUs > PUSH_REGISTRATION_RENEWAL_WINDOW_US) {
    return { ok: true, action: "not-due", expiresAtUs: registration.expiresAtUs };
  }
  return { ok: true, action: "renew", newExpiresAtUs: nowUs + PUSH_REGISTRATION_LIFETIME_US };
}

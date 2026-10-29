"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// 「共有する」 and 「リンクをコピー」 on a public sale page. The URL comes from
// the server, already checked to be a Production sale URL; null (Preview,
// local, anything uncertain) shows nothing. This component never builds a
// URL, reads settings, stores anything or makes a request. Each button is
// shown only when the browser offers that capability, and acts only on a
// click.

export const SHARE_FAILED_MESSAGE = "共有できませんでした。リンクをコピーしてお試しください。";
export const COPY_SUCCEEDED_MESSAGE = "リンクをコピーしました";
export const COPY_FAILED_MESSAGE = "コピーできませんでした";

// How long a result message stays before it is cleared.
const MESSAGE_MS = 4000;

type ShareNavigator = {
  share?: (data: { title?: string; url?: string }) => Promise<void>;
  clipboard?: { writeText?: (text: string) => Promise<void> };
};

export type ShareCapabilities = { share: boolean; copy: boolean };

export function detectShareCapabilities(nav: ShareNavigator | undefined): ShareCapabilities {
  return {
    share: typeof nav?.share === "function",
    copy: typeof nav?.clipboard?.writeText === "function",
  };
}

export type ShareResult = "shared" | "cancelled" | "failed";

// Closing the share sheet rejects with AbortError: that is a cancel, not a
// failure. Any other rejection (or a missing API) is a failure.
export async function shareLink(nav: ShareNavigator | undefined, title: string, url: string): Promise<ShareResult> {
  if (typeof nav?.share !== "function") return "failed";
  try {
    await nav.share({ title, url });
    return "shared";
  } catch (error) {
    return error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed";
  }
}

export type CopyResult = "copied" | "failed";

// Copied only when writeText resolves.
export async function copyLink(nav: ShareNavigator | undefined, url: string): Promise<CopyResult> {
  if (typeof nav?.clipboard?.writeText !== "function") return "failed";
  try {
    await nav.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}

// Runs one action at a time: a call made while another is still running is
// ignored (resolves to undefined without calling its action).
export function createSingleFlight(): <T>(action: () => Promise<T>) => Promise<T | undefined> {
  let running = false;
  return async (action) => {
    if (running) return undefined;
    running = true;
    try {
      return await action();
    } finally {
      running = false;
    }
  };
}

// The capabilities as a stable string for useSyncExternalStore: "," (none) on the
// server and until hydration, then what this browser offers. They never
// change while the page is open, so there is nothing to subscribe to.
function capabilityKey(nav: ShareNavigator | undefined): string {
  const { share, copy } = detectShareCapabilities(nav);
  return [share ? "share" : "", copy ? "copy" : ""].join(",");
}
const noSubscription = () => () => {};
const browserCapabilities = () => capabilityKey(typeof navigator === "undefined" ? undefined : navigator);
const serverCapabilities = () => ",";

const BUTTON_CLASS =
  "rounded-full border border-blue-500 bg-white px-4 py-2 text-sm font-semibold text-blue-500 disabled:opacity-50";

export function ShareActions({ shareUrl, title }: { shareUrl: string | null; title: string }) {
  // None on the server and during hydration, so both render no button.
  const key = useSyncExternalStore(noSubscription, browserCapabilities, serverCapabilities);
  const capabilities: ShareCapabilities = { share: key.startsWith("share"), copy: key.endsWith("copy") };
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [singleFlight] = useState(createSingleFlight);
  const mountedRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimeout(timerRef.current);
    };
  }, []);

  if (shareUrl === null || (!capabilities.share && !capabilities.copy)) return null;
  const url = shareUrl;

  function show(text: string) {
    if (!mountedRef.current) return;
    clearTimeout(timerRef.current);
    setMessage(text);
    if (text !== "") timerRef.current = setTimeout(() => setMessage(""), MESSAGE_MS);
  }

  // One action at a time; a second click while one runs does nothing.
  function run(action: () => Promise<string>) {
    return singleFlight(async () => {
      setBusy(true);
      show("");
      try {
        show(await action());
      } finally {
        if (mountedRef.current) setBusy(false);
      }
    });
  }

  const onShare = () =>
    run(async () => ((await shareLink(navigator, title, url)) === "failed" ? SHARE_FAILED_MESSAGE : ""));
  const onCopy = () =>
    run(async () => ((await copyLink(navigator, url)) === "copied" ? COPY_SUCCEEDED_MESSAGE : COPY_FAILED_MESSAGE));

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {capabilities.share ? (
          <button type="button" onClick={onShare} disabled={busy} aria-busy={busy} className={BUTTON_CLASS}>
            共有する
          </button>
        ) : null}
        {capabilities.copy ? (
          <button type="button" onClick={onCopy} disabled={busy} aria-busy={busy} className={BUTTON_CLASS}>
            リンクをコピー
          </button>
        ) : null}
      </div>
      <p role="status" aria-live="polite" className="min-h-5 text-sm text-foreground/70">
        {message}
      </p>
    </div>
  );
}

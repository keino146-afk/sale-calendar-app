import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  copyLink,
  COPY_FAILED_MESSAGE,
  createSingleFlight,
  COPY_SUCCEEDED_MESSAGE,
  detectShareCapabilities,
  SHARE_FAILED_MESSAGE,
  ShareActions,
  shareLink,
} from "./ShareActions";

// There is no DOM in these tests (as for AdminHomeLink): the browser
// behaviour lives in plain functions tested with fake navigators, and the
// component is rendered to static markup, which is what the server sends.

const SHARE_URL = "https://sale-calendar-app.vercel.app/sales/cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TITLE = "スーパーSALE（楽天市場）";

function abortError(): Error {
  const error = new Error("Share canceled");
  error.name = "AbortError";
  return error;
}

describe("detectShareCapabilities", () => {
  it("offers each action only when the browser has it", () => {
    const share = vi.fn(async () => {});
    const writeText = vi.fn(async () => {});
    expect(detectShareCapabilities({ share, clipboard: { writeText } })).toEqual({ share: true, copy: true });
    expect(detectShareCapabilities({ clipboard: { writeText } })).toEqual({ share: false, copy: true });
    expect(detectShareCapabilities({ share })).toEqual({ share: true, copy: false });
    expect(detectShareCapabilities({ clipboard: {} })).toEqual({ share: false, copy: false });
    expect(detectShareCapabilities({})).toEqual({ share: false, copy: false });
    expect(detectShareCapabilities(undefined)).toEqual({ share: false, copy: false });
  });
});

describe("shareLink", () => {
  it("shares the title and the given URL only, once", async () => {
    const share = vi.fn(async () => {});
    expect(await shareLink({ share }, TITLE, SHARE_URL)).toBe("shared");
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ title: TITLE, url: SHARE_URL });
  });

  it("treats closing the share sheet as a cancel, not a failure", async () => {
    expect(await shareLink({ share: vi.fn(async () => Promise.reject(abortError())) }, TITLE, SHARE_URL)).toBe("cancelled");
  });

  it.each([
    ["NotAllowedError", Object.assign(new Error("x"), { name: "NotAllowedError" })],
    ["a TypeError", new TypeError("bad data")],
    ["a non-Error value", "nope"],
  ])("fails on %s", async (_label, reason) => {
    expect(await shareLink({ share: vi.fn(async () => Promise.reject(reason)) }, TITLE, SHARE_URL)).toBe("failed");
  });

  it("fails without calling anything when the API is missing", async () => {
    expect(await shareLink({}, TITLE, SHARE_URL)).toBe("failed");
    expect(await shareLink(undefined, TITLE, SHARE_URL)).toBe("failed");
  });
});

describe("copyLink", () => {
  it("is copied only when writeText resolves, with exactly the given URL", async () => {
    const writeText = vi.fn(async () => {});
    expect(await copyLink({ clipboard: { writeText } }, SHARE_URL)).toBe("copied");
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(SHARE_URL);
  });

  it("fails when writeText rejects (no permission, not focused)", async () => {
    const writeText = vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })));
    expect(await copyLink({ clipboard: { writeText } }, SHARE_URL)).toBe("failed");
  });

  it("fails when the Clipboard API is missing", async () => {
    expect(await copyLink({ clipboard: {} }, SHARE_URL)).toBe("failed");
    expect(await copyLink({}, SHARE_URL)).toBe("failed");
    expect(await copyLink(undefined, SHARE_URL)).toBe("failed");
  });
});

describe("createSingleFlight", () => {
  it("ignores a second action while the first is still running, then accepts the next", async () => {
    const run = createSingleFlight();
    let release: () => void = () => {};
    const first = vi.fn(() => new Promise<string>((resolve) => (release = () => resolve("first"))));
    const second = vi.fn(async () => "second");

    const pending = run(first);
    expect(await run(second)).toBeUndefined();
    expect(second).not.toHaveBeenCalled();
    release();
    expect(await pending).toBe("first");

    expect(await run(second)).toBe("second");
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("is free again after an action fails", async () => {
    const run = createSingleFlight();
    await expect(run(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await run(async () => "ok")).toBe("ok");
  });
});

describe("ShareActions", () => {
  it("renders nothing without a share URL", () => {
    expect(renderToStaticMarkup(createElement(ShareActions, { shareUrl: null, title: TITLE }))).toBe("");
  });

  it("renders no button before the browser's capabilities are known (server render)", () => {
    const html = renderToStaticMarkup(createElement(ShareActions, { shareUrl: SHARE_URL, title: TITLE }));
    expect(html).toBe("");
    expect(html).not.toContain(SHARE_URL);
  });

  it("uses fixed Japanese messages that never include error details", () => {
    expect(SHARE_FAILED_MESSAGE).toBe("共有できませんでした。リンクをコピーしてお試しください。");
    expect(COPY_SUCCEEDED_MESSAGE).toBe("リンクをコピーしました");
    expect(COPY_FAILED_MESSAGE).toBe("コピーできませんでした");
  });
});

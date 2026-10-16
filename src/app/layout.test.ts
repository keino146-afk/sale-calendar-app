import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-sans" }),
  Geist_Mono: () => ({ variable: "font-mono" }),
}));

const { metadata } = await import("./layout");

describe("root metadata", () => {
  it("resolves relative URLs against the Production origin", () => {
    expect(metadata.metadataBase).toEqual(new URL("https://sale-calendar-app.vercel.app"));
  });

  it("uses a site-name default and template", () => {
    expect(metadata.title).toEqual({ default: "セールカレンダー", template: "%s | セールカレンダー" });
    expect(metadata.description).toContain("楽天市場・Amazon・Qoo10");
  });

  it("sets text-only Open Graph and Twitter defaults", () => {
    expect(metadata.openGraph).toMatchObject({ type: "website", siteName: "セールカレンダー", locale: "ja_JP" });
    expect(metadata.openGraph).not.toHaveProperty("images");
    expect(metadata.twitter).toMatchObject({ card: "summary" });
    expect(metadata.twitter).not.toHaveProperty("images");
  });

  it("sets no canonical or Open Graph URL for pages that do not set their own", () => {
    expect(metadata).not.toHaveProperty("alternates");
    expect(metadata.openGraph).not.toHaveProperty("url");
  });
});

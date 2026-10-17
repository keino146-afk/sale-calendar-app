import { describe, expect, it, vi } from "vitest";

vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-sans" }),
  Geist_Mono: () => ({ variable: "font-mono" }),
}));

const { default: manifest } = await import("./manifest");
const { viewport } = await import("./layout");

describe("web app manifest", () => {
  it("names the app セールカレンダー and starts standalone at the home page", () => {
    const m = manifest();

    expect(m.name).toBe("セールカレンダー");
    expect(m.short_name).toBe("セールカレンダー");
    expect(m.description).toBe(
      "楽天市場・Amazon・Qoo10の大型セールの開催予定と開催中のセールをまとめて確認できるセールカレンダーです。",
    );
    expect(m.start_url).toBe("/");
    expect(m.display).toBe("standalone");
    expect(m.background_color).toBe("#FFFFFF");
    expect(m.lang).toBe("ja");
  });

  it("uses the icon's red as theme colour, the same as the viewport's", () => {
    expect(manifest().theme_color).toBe("#E60418");
    expect(viewport.themeColor).toBe("#E60418");
  });

  it("lists the 192 / 512 icons and one maskable icon", () => {
    expect(manifest().icons).toEqual([
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ]);
  });

  it("sets no orientation, scope or other extras", () => {
    expect(Object.keys(manifest()).sort()).toEqual(
      ["background_color", "description", "display", "icons", "lang", "name", "short_name", "start_url", "theme_color"].sort(),
    );
  });
});

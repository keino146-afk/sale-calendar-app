import { describe, expect, it } from "vitest";
import robots from "./robots";

describe("robots", () => {
  it("allows public pages, keeps crawlers out of /admin and points at the Production sitemap", () => {
    expect(robots()).toEqual({
      rules: { userAgent: "*", allow: "/", disallow: "/admin" },
      sitemap: "https://sale-calendar-app.vercel.app/sitemap.xml",
    });
  });
});

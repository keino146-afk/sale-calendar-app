import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ADMIN_PRESENCE_PATH, AdminDashboardLink, AdminHomeLink, checkAdminPresence } from "./AdminHomeLink";

function respond(status: number, body?: string) {
  return vi.fn(async () => new Response(body ?? null, { status }));
}

describe("checkAdminPresence", () => {
  it("asks only /admin/presence, same-origin, without following redirects or caching", async () => {
    const fetchImpl = respond(204);

    await checkAdminPresence(fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(ADMIN_PRESENCE_PATH, {
      method: "GET",
      credentials: "same-origin",
      redirect: "error",
      cache: "no-store",
    });
    expect(ADMIN_PRESENCE_PATH).toBe("/admin/presence");
  });

  it("is true only for 200 with exactly {isAdmin: true}", async () => {
    expect(await checkAdminPresence(respond(200, JSON.stringify({ isAdmin: true })))).toBe(true);
  });

  it.each([
    ["204", respond(204)],
    ["401", respond(401, JSON.stringify({ isAdmin: true }))],
    ["403", respond(403, JSON.stringify({ isAdmin: true }))],
    ["500", respond(500, JSON.stringify({ isAdmin: true }))],
    ["invalid JSON", respond(200, "<html>login</html>")],
    ["isAdmin false", respond(200, JSON.stringify({ isAdmin: false }))],
    ["isAdmin as a string", respond(200, JSON.stringify({ isAdmin: "true" }))],
    ["extra fields", respond(200, JSON.stringify({ isAdmin: true, email: "x@example.invalid" }))],
    ["an array", respond(200, JSON.stringify([{ isAdmin: true }]))],
    ["null", respond(200, "null")],
    ["a network error / blocked redirect", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch")))],
  ])("is false for %s", async (_label, fetchImpl) => {
    expect(await checkAdminPresence(fetchImpl)).toBe(false);
  });
});

describe("AdminHomeLink", () => {
  it("renders nothing before the check (hidden by default)", () => {
    expect(renderToStaticMarkup(<AdminHomeLink />)).toBe("");
  });

  it("links admins to /admin in the same tab", () => {
    const html = renderToStaticMarkup(<AdminDashboardLink />);

    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toMatch(/<a [^>]*href="\/admin"[^>]*>管理画面へ<\/a>/);
    expect(html).not.toContain("target=");
  });
});

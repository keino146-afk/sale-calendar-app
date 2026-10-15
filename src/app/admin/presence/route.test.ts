import { afterEach, describe, expect, it, vi } from "vitest";

const { isAdminRequest } = vi.hoisted(() => ({ isAdminRequest: vi.fn() }));
vi.mock("@/server/auth/admin-session", () => ({ isAdminRequest }));

const route = await import("./route");

afterEach(() => {
  isAdminRequest.mockReset();
});

describe("GET /admin/presence", () => {
  it("answers an admin with exactly {isAdmin: true}, uncached", async () => {
    isAdminRequest.mockResolvedValue(true);

    const response = await route.GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ isAdmin: true });
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Location")).toBeNull();
  });

  it("answers everyone else with an empty, uncached 204 (no redirect, no identity)", async () => {
    isAdminRequest.mockResolvedValue(false);

    const response = await route.GET();

    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Location")).toBeNull();
  });

  it("exposes GET only", () => {
    expect(Object.keys(route)).toEqual(["GET"]);
  });
});

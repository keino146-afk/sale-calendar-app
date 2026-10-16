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
    isSameOriginRequest: vi.fn(),
    parseLoginForm: vi.fn(),
    signInAdmin: vi.fn(),
    signOutAdmin: vi.fn(),
    redirect: vi.fn((url: string) => {
      throw new RedirectSentinel(url);
    }),
    REDIRECT: RedirectSentinel,
  };
});

vi.mock("next/server", () => ({ connection: mocks.connection }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/server/auth/admin-session", () => ({
  requireAdmin: mocks.requireAdmin,
  ADMIN_HOME_PATH: "/admin",
  ADMIN_LOGIN_PATH: "/admin/login",
  ADMIN_LOGIN_FAILED_PATH: "/admin/login?error=1",
}));
vi.mock("@/server/auth/admin-auth", () => ({
  isSameOriginRequest: mocks.isSameOriginRequest,
  parseLoginForm: mocks.parseLoginForm,
  signInAdmin: mocks.signInAdmin,
  signOutAdmin: mocks.signOutAdmin,
}));

const { default: AdminLoginPage } = await import("./login/page");
const { metadata } = await import("./layout");
const { loginAction, logoutAction } = await import("./actions");

async function redirectUrl(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof mocks.REDIRECT) return error.url;
    throw error;
  }
  throw new Error("expected a redirect");
}

function loginProps(params: Record<string, string | string[] | undefined> = {}) {
  return { params: Promise.resolve({}), searchParams: Promise.resolve(params) };
}

beforeEach(() => {
  mocks.connection.mockResolvedValue(undefined);
  mocks.isSameOriginRequest.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const mock of [
    mocks.connection,
    mocks.requireAdmin,
    mocks.isSameOriginRequest,
    mocks.parseLoginForm,
    mocks.signInAdmin,
    mocks.signOutAdmin,
  ]) {
    mock.mockReset();
  }
  mocks.redirect.mockClear();
});

describe("admin layout", () => {
  it("keeps the admin area out of search engines", () => {
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("uses an absolute title so the root template does not add the site name twice", () => {
    expect(metadata.title).toEqual({ absolute: "管理画面 | セールカレンダー" });
  });
});

describe("AdminLoginPage", () => {
  it("renders the login form only", async () => {
    const html = renderToStaticMarkup(await AdminLoginPage(loginProps()));

    expect(mocks.connection).toHaveBeenCalledTimes(1);
    expect(html).toContain("管理者ログイン");
    expect(html).toContain('type="email"');
    expect(html).toContain('name="email"');
    expect(html).toContain('type="password"');
    expect(html).toContain('name="password"');
    expect(html).toContain("ログイン</button>");
    expect(html).not.toContain("ログインできませんでした");
  });

  it("has no sign-up or password-reset links", async () => {
    const html = renderToStaticMarkup(await AdminLoginPage(loginProps()));

    expect(html).not.toMatch(/<a\s/);
    expect(html).not.toMatch(/sign ?up|新規登録|アカウント作成|パスワードを忘れ|reset/i);
  });

  it("shows one generic error for any failure", async () => {
    const html = renderToStaticMarkup(await AdminLoginPage(loginProps({ error: "1" })));

    expect(html).toContain("ログインできませんでした");
    expect(html).toContain('role="alert"');
  });

  it("does not echo the error parameter", async () => {
    const html = renderToStaticMarkup(
      await AdminLoginPage(loginProps({ error: "<script>Invalid login credentials</script>" })),
    );

    expect(html).toContain("ログインできませんでした");
    expect(html).not.toContain("Invalid login credentials");
  });

  it("does not call the admin guard", async () => {
    await AdminLoginPage(loginProps());
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
  });
});

describe("loginAction", () => {
  const credentials = { email: "admin@example.invalid", password: "x" };

  it("goes to /admin after a successful admin login", async () => {
    mocks.parseLoginForm.mockReturnValue(credentials);
    mocks.signInAdmin.mockResolvedValue(true);

    expect(await redirectUrl(loginAction(new FormData()))).toBe("/admin");
    expect(mocks.signInAdmin).toHaveBeenCalledWith(credentials);
  });

  it("shows the generic failure for wrong credentials or non-admins", async () => {
    mocks.parseLoginForm.mockReturnValue(credentials);
    mocks.signInAdmin.mockResolvedValue(false);

    expect(await redirectUrl(loginAction(new FormData()))).toBe("/admin/login?error=1");
  });

  it("rejects invalid input without calling Supabase", async () => {
    mocks.parseLoginForm.mockReturnValue(null);

    expect(await redirectUrl(loginAction(new FormData()))).toBe("/admin/login?error=1");
    expect(mocks.signInAdmin).not.toHaveBeenCalled();
  });

  it("rejects a cross-site or Origin-less request before reading the form", async () => {
    mocks.isSameOriginRequest.mockResolvedValue(false);

    expect(await redirectUrl(loginAction(new FormData()))).toBe("/admin/login?error=1");
    expect(mocks.parseLoginForm).not.toHaveBeenCalled();
    expect(mocks.signInAdmin).not.toHaveBeenCalled();
  });
});

describe("logoutAction", () => {
  it("signs out and goes to the login page", async () => {
    mocks.signOutAdmin.mockResolvedValue(undefined);

    expect(await redirectUrl(logoutAction())).toBe("/admin/login");
    expect(mocks.signOutAdmin).toHaveBeenCalledTimes(1);
  });

  it("ignores a cross-site or Origin-less logout request", async () => {
    mocks.isSameOriginRequest.mockResolvedValue(false);

    expect(await redirectUrl(logoutAction())).toBe("/admin");
    expect(mocks.signOutAdmin).not.toHaveBeenCalled();
  });
});

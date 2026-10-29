import { afterEach, describe, expect, it, vi } from "vitest";
import { isProductionDeployment, PRODUCTION_SUPABASE_PROJECT_REF, productionSaleUrl } from "./share-url";

// Environment values are stubbed per test; nothing is read from a real
// deployment and no Supabase project is contacted. The Production host is
// public (it is the API host), the key is a fake.
const PRODUCTION_URL = `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`;
const PREVIEW_URL = "https://abcdefghijklmnopqrst.supabase.co";
const FAKE_KEY = "sb_publishable_FAKE0000test0000value";
const SALE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

// A setting that is passed as undefined is unset; one that is left out gets
// the Production project and a valid fake key.
function setEnv(options: { vercelEnv: string | undefined; supabaseUrl?: string | undefined; key?: string | undefined }) {
  vi.stubEnv("VERCEL_ENV", options.vercelEnv);
  vi.stubEnv("SUPABASE_URL", "supabaseUrl" in options ? options.supabaseUrl : PRODUCTION_URL);
  vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "key" in options ? options.key : FAKE_KEY);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isProductionDeployment", () => {
  it("is true only on Vercel Production with the Production Supabase project", () => {
    setEnv({ vercelEnv: "production" });
    expect(isProductionDeployment()).toBe(true);
  });

  it("accepts the Production origin with a trailing slash (normalized by env.ts)", () => {
    setEnv({ vercelEnv: "production", supabaseUrl: `${PRODUCTION_URL}/` });
    expect(isProductionDeployment()).toBe(true);
  });

  it.each([
    ["preview", "preview"],
    ["development", "development"],
    ["unset (local)", undefined],
    ["empty", ""],
    ["upper case", "PRODUCTION"],
    ["padded", " production"],
    ["a custom environment", "staging"],
  ])("is false when VERCEL_ENV is %s, even with the Production project", (_label, vercelEnv) => {
    setEnv({ vercelEnv });
    expect(isProductionDeployment()).toBe(false);
  });

  it.each([
    ["the Preview project", PREVIEW_URL],
    ["the ref with extra characters after it", `https://${PRODUCTION_SUPABASE_PROJECT_REF}x.supabase.co`],
    ["the ref with extra characters before it", `https://x${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`],
    ["the ref under another domain", `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co.example.com`],
    ["the ref as a subdomain of another project", `https://${PRODUCTION_SUPABASE_PROJECT_REF}.abcdefghijklmnopqrst.supabase.co`],
    ["http", `http://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co`],
    ["a port", `https://${PRODUCTION_SUPABASE_PROJECT_REF}.supabase.co:8443`],
    ["a local host", "http://127.0.0.1:54321"],
    ["not a URL", "not a url"],
    ["unset", undefined],
  ])("is false on Vercel Production with %s", (_label, supabaseUrl) => {
    setEnv({ vercelEnv: "production", supabaseUrl });
    expect(isProductionDeployment()).toBe(false);
  });

  it("is false when the Supabase settings cannot be read (invalid key)", () => {
    setEnv({ vercelEnv: "production", key: "sb_secret_FAKE" });
    expect(isProductionDeployment()).toBe(false);
  });
});

describe("productionSaleUrl", () => {
  it("is the Production sale URL on the Production deployment", () => {
    setEnv({ vercelEnv: "production" });
    expect(productionSaleUrl(SALE_ID)).toBe(`https://sale-calendar-app.vercel.app/sales/${SALE_ID}`);
  });

  it("lower-cases the id, as the canonical sale URL does", () => {
    setEnv({ vercelEnv: "production" });
    expect(productionSaleUrl(SALE_ID.toUpperCase())).toBe(`https://sale-calendar-app.vercel.app/sales/${SALE_ID}`);
  });

  it.each(["preview", "development", undefined])("is null on VERCEL_ENV=%s, so a Preview id never becomes a Production URL", (vercelEnv) => {
    setEnv({ vercelEnv, supabaseUrl: PREVIEW_URL });
    expect(productionSaleUrl(SALE_ID)).toBeNull();
  });

  it("is null on Production when the database is not the Production project", () => {
    setEnv({ vercelEnv: "production", supabaseUrl: PREVIEW_URL });
    expect(productionSaleUrl(SALE_ID)).toBeNull();
  });

  it.each(["", "not-a-uuid", `${SALE_ID}/extra`, `../${SALE_ID}`, `${SALE_ID}?x=1`, "https://example.com/"])(
    "is null for an id that is not a sale id (%s)",
    (id) => {
      setEnv({ vercelEnv: "production" });
      expect(productionSaleUrl(id)).toBeNull();
    },
  );
});

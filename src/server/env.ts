import "server-only";

// The only module allowed to read Supabase settings from process.env.
// Values are validated when the getter is called, never at import time, so
// `next build` works in environments without runtime configuration (CI).
// Error messages name the variable but never include its value.

export type SupabasePublicEnv = {
  url: string;
  publishableKey: string;
};

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

function readRequired(name: "SUPABASE_URL" | "SUPABASE_PUBLISHABLE_KEY"): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`${name} is not set`);
  }
  return value.trim();
}

function validateUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("SUPABASE_URL is not a valid URL");
  }

  if (parsed.username !== "" || parsed.password !== "") {
    throw new Error("SUPABASE_URL must not contain credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new Error("SUPABASE_URL must not contain a query or fragment");
  }
  if (parsed.pathname !== "/") {
    throw new Error("SUPABASE_URL must not contain a path");
  }

  const hostname = parsed.hostname.toLowerCase();

  if (LOCAL_HOSTNAMES.has(hostname)) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("SUPABASE_URL must not point to a local host in production");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("SUPABASE_URL must use http or https for a local host");
    }
    return parsed.origin;
  }

  if (parsed.protocol !== "https:") {
    throw new Error("SUPABASE_URL must use https");
  }
  if (parsed.port !== "") {
    throw new Error("SUPABASE_URL must not specify a port");
  }
  const suffix = ".supabase.co";
  if (!hostname.endsWith(suffix) || hostname.length === suffix.length) {
    throw new Error("SUPABASE_URL must be a *.supabase.co host");
  }
  const projectLabel = hostname.slice(0, -suffix.length);
  if (!/^[a-z0-9-]+$/.test(projectLabel)) {
    throw new Error("SUPABASE_URL must be a *.supabase.co host");
  }

  return parsed.origin;
}

function validatePublishableKey(key: string): string {
  if (key.startsWith("sb_secret_")) {
    throw new Error("SUPABASE_PUBLISHABLE_KEY must not be a secret key");
  }
  if (key.startsWith("eyJ")) {
    throw new Error("SUPABASE_PUBLISHABLE_KEY must not be a JWT-format key");
  }
  if (!/^sb_publishable_\S+$/.test(key)) {
    throw new Error("SUPABASE_PUBLISHABLE_KEY must be a publishable key");
  }
  return key;
}

export function getSupabasePublicEnv(): SupabasePublicEnv {
  return {
    url: validateUrl(readRequired("SUPABASE_URL")),
    publishableKey: validatePublishableKey(readRequired("SUPABASE_PUBLISHABLE_KEY")),
  };
}

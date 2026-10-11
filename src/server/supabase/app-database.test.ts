import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { AdminSupabaseClient } from "./admin-client";
import { SALE_EVENT_INSERT_COLUMNS, type SaleEventAppInsert } from "./app-database";

const VALID: SaleEventAppInsert = {
  retailer_id: "11111111-1111-4111-8111-111111111111",
  title: "スーパーSALE",
  description: null,
  starts_at: "2026-10-10T15:00:00.000Z",
  ends_at: "2026-10-13T15:00:00.000Z",
  is_date_only: true,
  source_url: "https://www.rakuten.co.jp/",
  source_checked_at: "2026-10-11T00:30:00.000Z",
};

// Compile-time guarantees, checked by `npm run typecheck` (never executed).
// Each @ts-expect-error fails the typecheck if that column ever becomes
// insertable through the admin client.
export function insertTypeGuarantees(client: AdminSupabaseClient) {
  void client.from("sale_events").insert(VALID);
  // @ts-expect-error status is set by the database default only
  void client.from("sale_events").insert({ ...VALID, status: "published" });
  // @ts-expect-error title_key is derived by a trigger
  void client.from("sale_events").insert({ ...VALID, title_key: "x" });
  // @ts-expect-error start_date_jst is derived by a trigger
  void client.from("sale_events").insert({ ...VALID, start_date_jst: "2026-10-11" });
  // @ts-expect-error published_at is set by the lifecycle trigger
  void client.from("sale_events").insert({ ...VALID, published_at: "2026-10-11T00:00:00Z" });
  // @ts-expect-error rejected_at is set by the lifecycle trigger
  void client.from("sale_events").insert({ ...VALID, rejected_at: "2026-10-11T00:00:00Z" });
  // @ts-expect-error archived_at is set by the lifecycle trigger
  void client.from("sale_events").insert({ ...VALID, archived_at: "2026-10-11T00:00:00Z" });
  // @ts-expect-error created_at has a database default
  void client.from("sale_events").insert({ ...VALID, created_at: "2026-10-11T00:00:00Z" });
  // @ts-expect-error updated_at is maintained by a trigger
  void client.from("sale_events").insert({ ...VALID, updated_at: "2026-10-11T00:00:00Z" });
  // @ts-expect-error id has a database default
  void client.from("sale_events").insert({ ...VALID, id: "22222222-2222-4222-8222-222222222222" });
  // @ts-expect-error a typed row cannot carry status either
  const typedRow: SaleEventAppInsert = { ...VALID, status: "published" };
  return typedRow;
}

const IMPORT_ARGS = {
  p_candidate_id: "33333333-3333-4333-8333-333333333333",
  p_retailer_id: VALID.retailer_id,
  p_title: VALID.title,
  p_description: null,
  p_starts_at: VALID.starts_at,
  p_ends_at: VALID.ends_at,
  p_is_date_only: true,
  p_source_url: VALID.source_url,
  p_source_checked_at: "2026-10-11T00:30:00.000Z",
};

// The candidate import RPC: description may be null, nothing else is widened.
export function importArgsTypeGuarantees(client: AdminSupabaseClient) {
  void client.rpc("import_collection_candidate", IMPORT_ARGS);
  void client.rpc("import_collection_candidate", { ...IMPORT_ARGS, p_description: "説明" });
  // @ts-expect-error the title is never null
  void client.rpc("import_collection_candidate", { ...IMPORT_ARGS, p_title: null });
  // @ts-expect-error the candidate id is required
  void client.rpc("import_collection_candidate", { ...IMPORT_ARGS, p_candidate_id: undefined });
}

describe("AppDatabase sale_events insert type", () => {
  it("allows exactly the eight columns granted to authenticated", async () => {
    const migration = await readFile("supabase/migrations/20261010015152_initial_schema.sql", "utf8");
    const grant = migration.match(/grant insert \(([^)]*)\) on table public\.sale_events to authenticated;/);
    const granted = grant?.[1].split(",").map((column) => column.trim()).sort();

    expect(granted).toHaveLength(8);
    expect([...SALE_EVENT_INSERT_COLUMNS].sort()).toEqual(granted);
    expect(Object.keys(VALID).sort()).toEqual(granted);
  });

  it("keeps the compile-time guarantees in the typechecked build", () => {
    expect(typeof insertTypeGuarantees).toBe("function");
    expect(typeof importArgsTypeGuarantees).toBe("function");
  });
});

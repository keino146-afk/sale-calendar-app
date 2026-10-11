import type { Database as GeneratedDatabase } from "./database.types";

// Application view of the generated schema types.
//
// The generator reads column nullability/defaults only, so it marks
// sale_events.title_key and start_date_jst as required on INSERT. At runtime a
// BEFORE INSERT trigger derives both, and the column-level GRANT lets clients
// insert exactly eight columns (see the initial migration). This type narrows
// sale_events.Insert to those eight columns; any other key (status,
// title_key, start_date_jst, lifecycle timestamps, ...) is a compile error
// through supabase-js' excess-property check. Everything else is the
// generated type unchanged.

type GeneratedPublic = GeneratedDatabase["public"];
type GeneratedSaleEvents = GeneratedPublic["Tables"]["sale_events"];

export const SALE_EVENT_INSERT_COLUMNS = [
  "retailer_id",
  "title",
  "description",
  "starts_at",
  "ends_at",
  "is_date_only",
  "source_url",
  "source_checked_at",
] as const;

export type SaleEventInsertColumn = (typeof SALE_EVENT_INSERT_COLUMNS)[number];

export type SaleEventAppInsert = Pick<GeneratedSaleEvents["Insert"], SaleEventInsertColumn>;

export type AppDatabase = Omit<GeneratedDatabase, "public"> & {
  public: Omit<GeneratedPublic, "Tables"> & {
    Tables: Omit<GeneratedPublic["Tables"], "sale_events"> & {
      sale_events: Omit<GeneratedSaleEvents, "Insert"> & { Insert: SaleEventAppInsert };
    };
  };
};

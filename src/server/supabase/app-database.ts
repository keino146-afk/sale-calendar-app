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

// The generator also marks every RPC argument as a non-null string. The
// candidate import accepts p_description = null (no description), exactly
// like sale_events.description, so that one argument is widened; the rest
// stays generated.
type GeneratedImportCandidate = GeneratedPublic["Functions"]["import_collection_candidate"];

export type ImportCollectionCandidateArgs = Omit<GeneratedImportCandidate["Args"], "p_description"> & {
  p_description: string | null;
};

// Same for the content update: p_description = null clears the description.
type GeneratedUpdateSaleEvent = GeneratedPublic["Functions"]["update_sale_event"];

export type UpdateSaleEventArgs = Omit<GeneratedUpdateSaleEvent["Args"], "p_description"> & {
  p_description: string | null;
};

// The lifecycle RPCs have two overloads each (Phase 6O): the original ones
// and the stale-checking ones with p_expected_updated_at. The application
// calls only the stale-checking overloads, so their arguments replace the
// generated (original) ones; the originals stay in the database for older
// application deployments only.
type ExpectedUpdatedAt = { p_expected_updated_at: string };
type LifecycleFunctions = {
  [Name in "publish_sale_event" | "archive_sale_event" | "reopen_sale_event" | "reject_sale_event"]: Omit<
    GeneratedPublic["Functions"][Name],
    "Args"
  > & { Args: GeneratedPublic["Functions"][Name]["Args"] & ExpectedUpdatedAt };
};
type LifecycleFunctionName = keyof LifecycleFunctions;

export type AppDatabase = Omit<GeneratedDatabase, "public"> & {
  public: Omit<GeneratedPublic, "Tables" | "Functions"> & {
    Tables: Omit<GeneratedPublic["Tables"], "sale_events"> & {
      sale_events: Omit<GeneratedSaleEvents, "Insert"> & { Insert: SaleEventAppInsert };
    };
    Functions: Omit<
      GeneratedPublic["Functions"],
      "import_collection_candidate" | "update_sale_event" | LifecycleFunctionName
    > &
      LifecycleFunctions & {
        import_collection_candidate: Omit<GeneratedImportCandidate, "Args"> & { Args: ImportCollectionCandidateArgs };
        update_sale_event: Omit<GeneratedUpdateSaleEvent, "Args"> & { Args: UpdateSaleEventArgs };
      };
  };
};

import "server-only";

// Errors thrown by the data access layer carry only generic messages.
// Supabase error details are logged server-side and never attached here.

export class DataAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataAccessError";
  }
}

export class InvalidQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidQueryError";
  }
}

export function logSupabaseError(context: string, error: { code?: string; message?: string }) {
  console.error(`[data] ${context}`, { code: error.code, message: error.message });
}

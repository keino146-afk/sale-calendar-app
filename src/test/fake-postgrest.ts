// Minimal fake of the PostgREST query builder for DAL unit tests.
// Records every chained call and resolves to a preset result.

export type RecordedCall = { method: string; args: unknown[] };

export type FakeResult = {
  data: unknown;
  error: { code?: string; message?: string } | null;
};

const CHAIN_METHODS = [
  "select",
  "eq",
  "lt",
  "gt",
  "order",
  "limit",
  "maybeSingle",
  "overrideTypes",
] as const;

export function createFakeSupabase(result: FakeResult) {
  const calls: RecordedCall[] = [];
  const tables: string[] = [];

  const builder: Record<string, unknown> = {
    then(resolve: (value: FakeResult) => unknown, reject?: (reason: unknown) => unknown) {
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  for (const method of CHAIN_METHODS) {
    builder[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return builder;
    };
  }

  const client = {
    from(table: string) {
      tables.push(table);
      return builder;
    },
  };

  return { client, calls, tables };
}

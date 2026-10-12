import type { Fetcher } from "./contract";

// Retries network errors and 5xx responses with exponential backoff. 4xx
// responses are returned as-is (a refusal is not retried). Anything still
// failing is left for the next scheduled run.
export function withRetry(
  fetcher: Fetcher,
  options: { attempts: number; baseDelayMs: number; sleep: (ms: number) => Promise<void> },
): Fetcher {
  return {
    async fetch(url) {
      let lastError: unknown;
      for (let attempt = 0; attempt < options.attempts; attempt++) {
        if (attempt > 0) await options.sleep(options.baseDelayMs * 2 ** (attempt - 1));
        try {
          const document = await fetcher.fetch(url);
          if (document.status < 500 || attempt === options.attempts - 1) return document;
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError instanceof Error ? lastError : new Error("fetch failed");
    },
  };
}

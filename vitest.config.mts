import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Test-only resolution. Next.js builds are unaffected: there, `server-only`
// still throws if a server module is imported from a Client Component.
export default defineConfig({
  resolve: {
    alias: {
      "server-only": fileURLToPath(new URL("./src/test/server-only-stub.ts", import.meta.url)),
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});

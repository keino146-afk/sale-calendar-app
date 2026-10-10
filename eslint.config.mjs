import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Supabase access stays on the server: only src/server/** may import
  // @supabase/*, and only src/server/env.ts may read Supabase env vars.
  // Client Components importing src/server/** are blocked by `server-only`.
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    ignores: ["src/server/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@supabase/*"],
              message: "Import Supabase only from src/server/**.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.{js,mjs,cjs,ts,tsx,mts,cts}"],
    ignores: ["src/server/env.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.name=/SUPABASE/]",
          message: "Read Supabase env vars only in src/server/env.ts.",
        },
        {
          selector:
            "MemberExpression[object.object.name='process'][object.property.name='env'][property.value=/SUPABASE/]",
          message: "Read Supabase env vars only in src/server/env.ts.",
        },
        {
          selector:
            "VariableDeclarator[init.object.name='process'][init.property.name='env'] > ObjectPattern > Property[key.name=/SUPABASE/]",
          message: "Read Supabase env vars only in src/server/env.ts.",
        },
      ],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;

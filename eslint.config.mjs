// @ts-check
import eslint from "@eslint/js";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

export default defineConfig(
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      // allow unused variables/args if they start with _
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          caughtErrors: "none",
          varsIgnorePattern: "^_",
          argsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    ignores: [
      "node_modules/**/*",
      "infrastructure/**/*",
      "scripts/**/*",
      "dist/**/*",
    ],
  },
  eslintConfigPrettier,
);

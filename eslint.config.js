import js from "@eslint/js";
import tseslint from "typescript-eslint";
import solid from "eslint-plugin-solid/configs/typescript";
import * as tsParser from "@typescript-eslint/parser";
import eslintConfigPrettier from "eslint-config-prettier/flat";

export default [
  // Ignore build output
  {
    ignores: ["dist/**", "dist-electron/**", "release/**", "node_modules/**"],
  },

  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript strict rules (non-type-checked to avoid perf cost in CI)
  ...tseslint.configs.strict,

  // SolidJS-specific rules for TSX files
  {
    files: ["src/**/*.{ts,tsx}"],
    ...solid,
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
  },

  // Electron backend files use Node tsconfig
  {
    files: ["electron/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./electron/tsconfig.json",
      },
    },
  },

  // Custom strict rules
  {
    files: ["**/*.{ts,tsx}"],
    rules: {
      // Prevent `any` — use `unknown` instead
      "@typescript-eslint/no-explicit-any": "error",

      // Require explicit return types on exported functions
      "@typescript-eslint/explicit-module-boundary-types": "off",

      // No unused variables (underscore prefix allowed for intentional skips)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Consistency
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
      curly: ["error", "multi-line"],

      // No console.log (allow warn/error for legitimate error reporting)
      "no-console": ["warn", { allow: ["warn", "error"] }],

      // Prevent non-null assertions (prefer explicit checks)
      "@typescript-eslint/no-non-null-assertion": "warn",
    },
  },

  // Disable rules that conflict with Prettier (must be last)
  eslintConfigPrettier,
];

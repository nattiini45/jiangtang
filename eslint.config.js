import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import prettier from "eslint-config-prettier";

/**
 * Lean, correctness-focused lint. Formatting is Prettier's job
 * (eslint-config-prettier disables conflicting rules); lint exists to catch
 * the bugs that matter in an AI-maintained codebase — floating promises in
 * loaders/actions/workers, hook-dependency mistakes, dead code.
 */
export default tseslint.config(
  {
    ignores: [
      "app/generated/**",
      "build/**",
      ".react-router/**",
      "node_modules/**",
      "coverage/**",
      ".claude/**",
      "public/**",
      // Generated Playwright artifacts (gitignored; lint must not scan the
      // bundled HTML report or failure traces).
      "playwright-report/**",
      "test-results/**",
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  reactHooks.configs.recommended,
  {
    // Type-aware rules only where a tsconfig project covers the files.
    files: ["app/**/*.{ts,tsx}", "scripts/**/*.ts", "test/**/*.ts", "e2e/**/*.ts", "server.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", { ignoreVoid: true }],
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false } },
      ],
    },
  },
  {
    rules: {
      // Loaders/actions destructure unused args; underscore opt-out.
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
      // Pre-existing casts at RR/Prisma boundaries; tighten later, don't churn now.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // server.ts + boot modules register async Express handlers / interval ticks
    // by design (each tick try/catches internally); the void-return arg check
    // is a false positive there. no-floating-promises stays active.
    files: ["server.ts", "app/lib/**/*.boot.server.ts"],
    rules: {
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/await-thenable": "off",
    },
  },
  {
    // Tests replicate runtime config with require() on purpose.
    files: ["**/__tests__/**", "test/**"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  prettier,
);

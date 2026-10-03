import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  { ignores: ["out/**", "node_modules/**", "tmp/**", "build/**", "release/**", ".cache/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["scripts/**/*.mjs"], languageOptions: { globals: { process: "readonly", console: "readonly" } } },
  {
    files: ["scripts/**/*.cjs"],
    languageOptions: { sourceType: "commonjs", globals: { require: "readonly", exports: "writable", module: "writable", process: "readonly", console: "readonly" } },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  {
    files: ["src/**/*.{ts,tsx}", "test/**/*.ts"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // The renderer runs sandboxed: no Node APIs.
    files: ["src/renderer/**", "src/shared/**"],
    rules: { "no-restricted-imports": ["error", { patterns: [{ group: ["node:*", "electron", "../pipeline/*", "../main/*"], message: "renderer/shared code must not use Node or the pipeline directly" }] }] },
  },
);

// @ts-check
import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", ".claude/**"] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser } },
    plugins: { "react-hooks": reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // TanStack Router redirects by throwing redirect(); allow exactly that.
      "@typescript-eslint/only-throw-error": [
        "error",
        { allow: [{ from: "package", package: "@tanstack/router-core", name: "Redirect" }] },
      ],
      // @grounded/core's index also loads method.md from disk (node:fs), which the browser can't:
      // the web takes its types, and code only from subpaths made for it.
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@grounded/core",
              allowTypeImports: true,
              message: "Import code from a browser-safe subpath, e.g. @grounded/core/attachments.",
            },
          ],
        },
      ],
    },
  },
  {
    // Tests run in Node, where all of @grounded/core loads.
    files: ["apps/web/**/*.test.{ts,tsx}"],
    rules: { "@typescript-eslint/no-restricted-imports": "off" },
  },
  {
    files: ["**/*.js"],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);

import globals from "globals";

/**
 * Deliberately minimal. `no-undef` is the point: a helper used but never
 * imported is a runtime ReferenceError, and the app's broad `try/catch` blocks
 * swallow it silently. That is exactly how `putAssetFromDataUrl` shipped.
 */
export default [
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: {
      "no-undef": "error",
      "no-unused-vars": [
        "warn",
        {
          // Destructuring rest is used to *drop* keys, so `_name` is meaningful.
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs", "vite.config.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: { "no-undef": "error" },
  },
  {
    // Test files run in Node but their `page.evaluate` callbacks are shipped
    // to the browser, so both global sets legitimately apply.
    files: ["tests/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { "no-undef": "error" },
  },
];

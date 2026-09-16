import js from "@eslint/js";

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.js", "test/**/*.js", "scripts/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        fetch: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
        structuredClone: "readonly",
        crypto: "readonly",
      },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-constant-condition": ["error", { checkLoops: false }],
      eqeqeq: ["error", "always", { null: "ignore" }],
    },
  },
];

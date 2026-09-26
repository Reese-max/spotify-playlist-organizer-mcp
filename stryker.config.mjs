// Stryker mutation testing.
// node:test has no dedicated Stryker runner, so the `command` runner executes
// the real suite (`node --test`) for every mutant and treats a nonzero exit as
// a killed mutant. That makes a full run slow — scope it when iterating:
//   npx stryker run --mutate src/library.js
//   npx stryker run --mutate "src/{canonical,library}.js"
// Mutation testing is a periodic deep check, not a per-commit gate.

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: "command",
  commandRunner: { command: "node --test" },
  coverageAnalysis: "off",
  mutate: ["src/**/*.js", "!src/server.js"],
  mutator: { excludedMutations: ["StringLiteral"] },
  reporters: ["clear-text", "progress", "html"],
  htmlReporter: { fileName: "reports/mutation/index.html" },
  concurrency: 4,
  timeoutMS: 30_000,
  timeoutFactor: 3,
  cleanTempDir: true,
};

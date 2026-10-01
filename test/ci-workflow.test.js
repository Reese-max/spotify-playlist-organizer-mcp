import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflowPath = path.join(repoRoot, ".github", "workflows", "ci.yml");

function readWorkflow() {
  return readFileSync(workflowPath, "utf8");
}

test("a push/PR CI workflow exists", () => {
  const workflow = readWorkflow();
  assert.match(workflow, /^ {2}push:\s*$/m, "workflow must trigger on push");
  assert.match(workflow, /^ {2}pull_request:\s*$/m, "workflow must trigger on pull_request");
});

test("workflow permissions stay read-only", () => {
  const workflow = readWorkflow();
  assert.match(workflow, /^permissions:\s*$/m);
  assert.match(workflow, /^ {2}contents:\s*read\s*$/m);
});

test("job enforces a bounded timeout", () => {
  const match = readWorkflow().match(/^\s+timeout-minutes:\s*(\d+)\s*$/m);
  assert.ok(match, "workflow must set timeout-minutes");
  assert.ok(Number(match[1]) <= 15, "job timeout must stay bounded");
});

test("CI installs with npm ci and runs the full regression suite", () => {
  const workflow = readWorkflow();
  assert.match(workflow, /^\s*run:\s+npm ci\s*$/m);
  assert.match(workflow, /^\s*run:\s+npm run lint\s*$/m);
  assert.match(workflow, /^\s*run:\s+npm run test:coverage\s*$/m, "CI must run the node --test suite including mcp-smoke");
});

test("CI pins one Node runtime inside the declared engines range", () => {
  const match = readWorkflow().match(/^\s*node-version:\s*["']?(\d+)["']?\s*$/m);
  assert.ok(match, "workflow must pin a node-version");
  assert.ok(Number(match[1]) >= 24, "node-version must satisfy engines >=24");
});

test("CI injects no provider credentials and never downgrades failures", () => {
  const workflow = readWorkflow();
  assert.ok(!/\$\{\{\s*secrets\b/.test(workflow), "workflow must not pass OAuth/provider secrets");
  assert.ok(!/continue-on-error/i.test(workflow), "a failing suite must fail the job, not warn");
});

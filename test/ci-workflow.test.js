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

// Contract predicates — each returns true when the workflow text violates the contract.

function triggerViolation(workflow) {
  const section = workflow.match(/^on:\s*\n([\s\S]*?)(?=^\S)/m)?.[1];
  if (section === undefined || /^ {3,}\S/m.test(section)) return true;
  const names = [...section.matchAll(/^ {2}(\w[^:\n]*):\s*$/gm)].map((m) => m[1].trim()).sort();
  return names.join() !== "pull_request,push";
}

function permissionViolation(workflow) {
  if ((workflow.match(/^\s*permissions\s*:/gm) ?? []).length !== 1) return true;
  const block = workflow.match(/^permissions:\s*\n((?: {2}\S[^\n]*\n?)+)/m);
  const grants = block
    ? [...block[1].matchAll(/^ {2}(\w[\w-]*):\s*([\w-]+)\s*$/gm)].map((m) => `${m[1]}: ${m[2]}`)
    : [];
  return grants.join() !== "contents: read";
}

function credentialViolation(workflow) {
  return (
    /\$\{\{\s*secrets\b/.test(workflow) ||
    /^\s*secrets\s*:/m.test(workflow) ||
    /^\s*environment\s*:/m.test(workflow)
  );
}

function jobViolation(workflow) {
  const section = workflow.match(/^jobs:\s*\n([\s\S]*)$/m)?.[1];
  if (section === undefined) return true;
  const jobs = section.match(/^ {2}\w[^:\n]*:/gm) ?? [];
  return jobs.length !== 1 || /^\s+if\s*:/m.test(section);
}

function timeoutViolation(workflow) {
  const lines = workflow.match(/^\s*timeout-minutes\s*:/gm) ?? [];
  const values = [...workflow.matchAll(/^\s*timeout-minutes:\s*(\d+)\s*$/gm)].map((m) => Number(m[1]));
  return lines.length !== 1 || values.length !== 1 || values[0] > 15;
}

function nodeViolation(workflow) {
  const lines = workflow.match(/^\s*node-version\s*:/gm) ?? [];
  const values = [...workflow.matchAll(/^\s*node-version:\s*["']?(\d+)["']?\s*$/gm)].map((m) =>
    Number(m[1]),
  );
  return lines.length !== 1 || values.length !== 1 || values[0] < 24;
}

function stepViolation(workflow) {
  return (
    !/^\s*run:\s+npm ci\s*$/m.test(workflow) ||
    !/^\s*run:\s+npm run lint\s*$/m.test(workflow) ||
    !/^\s*run:\s+npm run test:coverage\s*$/m.test(workflow)
  );
}

const downgradeViolation = (workflow) => /continue-on-error/i.test(workflow);

test("a push/PR CI workflow exists and stays unfiltered", () => {
  assert.ok(
    !triggerViolation(readWorkflow()),
    "workflow must trigger on push/pull_request only — no pull_request_target, filters, or extra events",
  );
});

test("workflow permissions stay read-only", () => {
  assert.ok(
    !permissionViolation(readWorkflow()),
    "permissions must be a single top-level contents: read block — no extra grants or job-level overrides",
  );
});

test("the workflow runs exactly one unconditional job", () => {
  assert.ok(
    !jobViolation(readWorkflow()),
    "jobs: must contain exactly one job with no `if:` gate — extra or skipped jobs escape the timeout/credential contract",
  );
});

test("the job enforces a bounded timeout", () => {
  assert.ok(
    !timeoutViolation(readWorkflow()),
    "the job must set a literal timeout-minutes <= 15",
  );
});

test("CI installs with npm ci and runs the full regression suite", () => {
  assert.ok(
    !stepViolation(readWorkflow()),
    "CI must run npm ci, npm run lint, and npm run test:coverage (the node --test suite including mcp-smoke)",
  );
});

test("CI pins a Node runtime inside the declared engines range", () => {
  assert.ok(
    !nodeViolation(readWorkflow()),
    "the workflow must pin a literal node-version satisfying engines >=24",
  );
});

test("CI injects no provider credentials and never downgrades failures", () => {
  const workflow = readWorkflow();
  assert.ok(
    !credentialViolation(workflow),
    "workflow must not reference secrets, reusable-workflow secrets, or environment bindings",
  );
  assert.ok(!downgradeViolation(workflow), "a failing suite must fail the job, not warn");
});

test("contract guards reject evading workflows", () => {
  assert.ok(
    credentialViolation("jobs:\n  call:\n    uses: ./.github/workflows/x.yml\n    secrets: inherit\n"),
    "reusable-workflow secrets: inherit must be rejected",
  );
  assert.ok(
    credentialViolation("jobs:\n  t:\n    runs-on: ubuntu-latest\n    environment: production\n"),
    "environment-scoped secret bindings must be rejected",
  );
  assert.ok(
    credentialViolation("      env:\n        TOKEN: ${{ secrets.TOKEN }}\n"),
    "secret expressions must be rejected",
  );
  assert.ok(
    permissionViolation("permissions:\n  contents: read\n  id-token: write\n"),
    "extra write grants under permissions must be rejected",
  );
  assert.ok(
    permissionViolation(readWorkflow() + "    permissions:\n      contents: write\n"),
    "a nested job-level permissions block must be rejected",
  );
  assert.ok(
    triggerViolation("on:\n  push:\n  pull_request:\n  pull_request_target:\n"),
    "pull_request_target must be rejected",
  );
  assert.ok(
    triggerViolation("on:\n  push:\n    branches: [main]\n  pull_request:\n"),
    "a nested trigger filter must be rejected",
  );
  assert.ok(
    triggerViolation("on:\n  push: {branches: [main]}\n  pull_request:\n"),
    "a flow-style trigger filter must be rejected",
  );
  assert.ok(
    jobViolation(`${readWorkflow()}  extra:\n    runs-on: ubuntu-latest\n`),
    "a second job must be rejected",
  );
  assert.ok(
    jobViolation(readWorkflow().replace("  test:\n", "  test:\n    if: false\n")),
    "a condition-gated job must be rejected",
  );
  assert.ok(
    timeoutViolation("jobs:\n  a:\n    runs-on: ubuntu-latest\n    timeout-minutes: 60\n"),
    "a job timeout above the bound must be rejected",
  );
  assert.ok(
    timeoutViolation("jobs:\n  a:\n    runs-on: ubuntu-latest\n"),
    "a missing timeout must be rejected",
  );
  assert.ok(
    timeoutViolation("    timeout-minutes: ${{ vars.MINS }}\n"),
    "a non-literal timeout must be rejected",
  );
  assert.ok(
    nodeViolation("        with:\n          node-version: 20\n"),
    "a node-version below engines must be rejected",
  );
  assert.ok(
    nodeViolation("          node-version: ${{ matrix.node }}\n"),
    "a non-literal node-version must be rejected",
  );
});

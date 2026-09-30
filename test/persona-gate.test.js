import assert from "node:assert/strict";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CHECKS,
  PERSONA_MATRIX,
  PERSONA_STATUSES,
  formatReport,
  main,
  runPersonaGate,
} from "../scripts/persona-gate.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const EXPECTED_IDS = Object.freeze(
  ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]
    .flatMap((row) => ["01", "02", "03", "04", "05"].map((n) => `${row}${n}`)),
);

// Checks whose fixed expectation is verifiable in-process and must hold on the
// current default branch. The one declared-open defect that is detectable
// in-repo (#8, interactive passphrase echo) is exercised through the TRACKED
// path below.
const REQUIRED_PASS_CHECKS = Object.freeze([
  "preview_is_default",
  "free_text_requires_selection",
  "selected_video_binds",
  "exact_id_fast_path",
  "exact_duplicate_no_rewrite",
  "provider_deadline",
  "caller_cancellation",
  "ambiguous_write_typed",
  "no_blind_write_retry",
  "exact_id_readback_reconcile",
  "invalid_input_rejected",
  "pagination_bounded",
  "identity_lock_blocks_alias",
  "canonical_version_distinct",
  "sync_state_rejects_secrets",
  "credentials_encrypted_at_rest",
  "receipt_carries_no_secret",
  "ci_workflow_declared",
  "stdio_signal_exit",
  "concurrent_save_serialized",
]);

function sink() {
  return { text: "", write(chunk) { this.text += chunk; } };
}

test("the gate matrix is exactly the fixed A01–J05 grid", () => {
  assert.equal(PERSONA_MATRIX.length, 50);
  assert.deepEqual(PERSONA_MATRIX.map((p) => p.id), EXPECTED_IDS);
  assert.ok(Object.isFrozen(PERSONA_MATRIX));

  const checkIds = new Set(Object.keys(CHECKS));
  for (const persona of PERSONA_MATRIX) {
    assert.ok(persona.label.length > 0, persona.id);
    assert.ok(Object.isFrozen(persona), persona.id);
    for (const checkId of persona.checks) {
      assert.ok(checkIds.has(checkId), `${persona.id} references unknown check ${checkId}`);
    }
    for (const gap of persona.runtime) {
      assert.equal(typeof gap, "string", persona.id);
      assert.ok(gap.length > 0, persona.id);
    }
  }
  for (const [checkId, check] of Object.entries(CHECKS)) {
    assert.equal(typeof check.run, "function", checkId);
    for (const issue of check.issues) {
      assert.match(issue, /^#\d+$/, `${checkId} issue ref`);
    }
  }
});

test("the gate evaluates all 50 personas and finds no untracked defect", async () => {
  const report = await runPersonaGate({ root });

  assert.equal(report.gate, "fixed-50-persona-a01-j05");
  assert.equal(report.personas.length, 50);
  assert.deepEqual(report.personas.map((p) => p.id), EXPECTED_IDS);

  for (const persona of report.personas) {
    assert.ok(PERSONA_STATUSES.includes(persona.status), `${persona.id} status`);
    assert.equal(persona.checks.length, PERSONA_MATRIX.find((p) => p.id === persona.id).checks.length);
    for (const check of persona.checks) {
      assert.equal(typeof check.ok, "boolean", `${persona.id}/${check.id}`);
      assert.equal(typeof check.detail, "string", `${persona.id}/${check.id}`);
      // The gate's core invariant: a failing check must be bound to a
      // declared open tracker; an unbound failure is a new reproducible defect.
      if (!check.ok) assert.ok(check.issues.length > 0, `${persona.id}/${check.id} is untracked`);
    }
    // Status consistency: TRACKED iff every failure is issue-bound.
    const failed = persona.checks.filter((c) => !c.ok);
    if (persona.status === "FAIL") assert.ok(failed.some((c) => c.issues.length === 0));
    if (persona.status === "TRACKED") {
      assert.ok(failed.length > 0);
      assert.ok(persona.issues.length > 0);
    }
    if (persona.status === "NEEDS_RUNTIME") assert.ok(persona.runtime.length > 0);
    if (persona.status === "PASS") {
      assert.equal(failed.length, 0);
      assert.equal(persona.runtime.length, 0);
    }
  }

  assert.equal(report.summary.total, 50);
  assert.equal(
    report.summary.pass + report.summary.tracked
      + report.summary.needsRuntime + report.summary.fail,
    50,
  );
  assert.equal(report.summary.fail, 0);
  // Current default still has runtime gaps (real provider/OAuth/client), so
  // the honest verdict is NOT_CLEAN — the umbrella stays open.
  assert.equal(report.verdict, "NOT_CLEAN");

  const byCheck = Object.fromEntries(
    report.personas.flatMap((p) => p.checks.map((c) => [[p.id, c.id], c])),
  );
  for (const checkId of REQUIRED_PASS_CHECKS) {
    const results = report.personas
      .flatMap((p) => p.checks.filter((c) => c.id === checkId));
    assert.ok(results.length > 0, `check ${checkId} is exercised by at least one persona`);
    assert.ok(results.every((r) => r.ok), `check ${checkId} must pass on current default`);
  }
  assert.ok(Object.keys(byCheck).length > 0);
});

test("the tracked defect set matches the declared open audit findings", async () => {
  const report = await runPersonaGate({ root });
  const trackedIssues = [...new Set(report.personas.flatMap((p) => p.issues))].sort();

  // #8 is the only reproducible current-default defect the in-repo probes can
  // detect: the interactive passphrase prompt echoes on a TTY because the
  // readline interface is wired to the real stdout.
  assert.deepEqual(trackedIssues, ["#8"]);
  assert.ok(report.personas.some((p) => p.status === "TRACKED"));
  assert.equal(report.summary.fail, 0);
  assert.ok(report.summary.tracked > 0);
});

test("formatReport renders the 50-row matrix and the verdict", async () => {
  const report = await runPersonaGate({ root });
  const text = formatReport(report);

  for (const id of EXPECTED_IDS) assert.ok(text.includes(id), `matrix row ${id}`);
  assert.ok(text.includes("NOT_CLEAN"));
  assert.ok(text.includes("50"));
});

test("CLI main reports exit codes and emits JSON on demand", async () => {
  const out = sink();
  assert.equal(await main({ argv: [], out, root }), 0);
  assert.ok(out.text.includes("NOT_CLEAN"));

  const strictOut = sink();
  assert.equal(await main({ argv: ["--strict"], out: strictOut, root }), 1);

  const jsonOut = sink();
  assert.equal(await main({ argv: ["--json"], out: jsonOut, root }), 0);
  const parsed = JSON.parse(jsonOut.text);
  assert.equal(parsed.personas.length, 50);
  assert.equal(parsed.verdict, "NOT_CLEAN");
});

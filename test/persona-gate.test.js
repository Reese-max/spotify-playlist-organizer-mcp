import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
const ROUND_ONE_REPORT = ".github/quality-audits/2026-09-14-0834Z-50-persona-audit-round-1.md";
const ROUND_ONE_REPORT_BLOB_SHA = "df97d763c208cef415f44f79e35c029c9c504de8";
const PORTFOLIO_PROTOCOL_BLOB_SHA = "6e3499d6ef5be7e123050e1526946f6a40f99263";
const PROBE_MAPPING_SHA256 = "d50240e7d9529d5817ab63a48dcfa6af7c18bf205c70047120235863d2a44b50";

const EXPECTED_IDS = Object.freeze(
  ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"]
    .flatMap((row) => ["01", "02", "03", "04", "05"].map((n) => `${row}${n}`)),
);

// Checks whose fixed expectation is verifiable in-process and must hold on the
// current default branch. A regression against a resolved finding must become
// FAIL rather than being hidden behind a stale issue tracker.
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

test("the pinned audit keeps LF bytes on autocrlf checkouts", () => {
  const attributes = spawnSync("git", ["check-attr", "eol", "--", ROUND_ONE_REPORT], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(attributes.status, 0, attributes.stderr);
  assert.match(attributes.stdout, /: eol: lf\r?\n$/);
});

test("the stdio signal probe exercises clean shutdown on this platform", async () => {
  assert.match(await CHECKS.stdio_signal_exit.run({ root }), /SIGTERM.*exits 0/);
});

test("the no-echo probe rejects a helper that echoes typed input", async () => {
  const directory = await mkdtemp(resolve(tmpdir(), "persona-gate-echo-"));
  try {
    for (const folder of ["src", "scripts", "test"]) {
      await mkdir(resolve(directory, folder));
    }
    for (const file of ["package.json", "scripts/youtube-auth.js", "test/youtube-auth.test.js"]) {
      await cp(resolve(root, file), resolve(directory, file));
    }
    const original = await readFile(resolve(root, "src/hidden-input.js"), "utf8");
    await writeFile(resolve(directory, "src/hidden-input.js"), original);
    assert.match(await CHECKS.credential_prompt_no_echo.run({ root: directory }), /echo|hides input/i);
    const leaking = original.replace(
      "const onData = (original) => {",
      "const onData = (original) => { output.write(original);",
    );
    assert.notEqual(leaking, original, "negative control must actually introduce an echo");
    await writeFile(resolve(directory, "src/hidden-input.js"), leaking);
    await assert.rejects(CHECKS.credential_prompt_no_echo.run({ root: directory }), /echo/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function readCanonicalScenarios() {
  const markdown = await readFile(resolve(root, ROUND_ONE_REPORT), "utf8");
  const bytes = Buffer.from(markdown, "utf8");
  const blobSha = createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
  assert.equal(blobSha, ROUND_ONE_REPORT_BLOB_SHA);

  const rows = markdown
    .split(/\r?\n/)
    .filter((line) => /^\| [A-J]0[1-5] /.test(line));
  assert.equal(rows.length, 50);
  return rows.map((line) => {
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    assert.equal(cells.length, 8);
    const match = cells[0].match(/^([A-J]0[1-5]) (.+)$/);
    assert.ok(match);
    return {
      id: match[1],
      persona: match[2],
      goal: cells[1],
      input: cells[2],
      steps: cells[3],
      expected: cells[4],
      observation: cells[5],
      evidence: cells[6],
      finding: cells[7],
    };
  });
}

test("the gate matrix is exactly the fixed A01–J05 grid", async () => {
  const scenarios = await readCanonicalScenarios();
  assert.equal(PERSONA_MATRIX.length, 50);
  assert.deepEqual(PERSONA_MATRIX.map((p) => p.id), EXPECTED_IDS);
  assert.deepEqual(scenarios.map((scenario) => scenario.id), EXPECTED_IDS);
  assert.ok(Object.isFrozen(PERSONA_MATRIX));
  const probeMapping = PERSONA_MATRIX.map(({ id, checks, runtime }) => ({ id, checks, runtime }));
  assert.equal(
    createHash("sha256").update(JSON.stringify(probeMapping)).digest("hex"),
    PROBE_MAPPING_SHA256,
    "check/runtime assignments changed; review the fixed gate mapping before updating its pin",
  );

  const checkIds = new Set(Object.keys(CHECKS));
  assert.deepEqual([...new Set(PERSONA_MATRIX.flatMap((persona) => persona.checks))].sort(),
    Object.keys(CHECKS).sort());
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
  assert.deepEqual(CHECKS.credential_prompt_no_echo.issues, []);
  for (const [checkId, check] of Object.entries(CHECKS)) {
    assert.equal(typeof check.run, "function", checkId);
    for (const issue of check.issues) {
      assert.match(issue, /^#\d+$/, `${checkId} issue ref`);
    }
  }
});

test("the gate evaluates all 50 personas and finds no untracked defect", async () => {
  const report = await runPersonaGate({ root });
  const scenarios = await readCanonicalScenarios();

  assert.equal(report.gate, "fixed-50-persona-a01-j05");
  assert.equal(report.specBlobSha, PORTFOLIO_PROTOCOL_BLOB_SHA);
  assert.equal(report.scenarioSource, ROUND_ONE_REPORT);
  assert.equal(report.scenarioSourceBlobSha, ROUND_ONE_REPORT_BLOB_SHA);
  assert.equal(report.personas.length, 50);
  assert.deepEqual(report.personas.map((p) => p.id), EXPECTED_IDS);
  assert.deepEqual(report.personas.map((p) => p.scenario), scenarios);
  assert.deepEqual(report.personas.map((p) => p.label), scenarios.map((p) => p.persona));

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

test("resolved passphrase echo regressions are not downgraded to TRACKED", async () => {
  const report = await runPersonaGate({ root });
  const trackedIssues = [...new Set(report.personas.flatMap((p) => p.issues))].sort();

  assert.deepEqual(trackedIssues, []);
  assert.equal(report.summary.tracked, 0);
  assert.equal(report.summary.fail, 0);
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

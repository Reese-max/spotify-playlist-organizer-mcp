import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { loadEnvFile } from "../src/env.js";

const execFileAsync = promisify(execFile);

function minimalEnv(extra = {}) {
  return {
    PATH: process.env.PATH ?? process.env.Path,
    SystemRoot: process.env.SYSTEMROOT ?? process.env.SystemRoot,
    ...extra,
  };
}

test("loadEnvFile is a no-op when no .env exists and never throws", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "env-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(loadEnvFile(path.join(directory, ".env")), false);
});

test("a clean process with only a .env file reads the required keys", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "env-onboard-"));
  const envPath = path.join(directory, ".env");
  await writeFile(envPath, "SMOKE_GOOGLE_CLIENT_ID=cid-from-dotenv\nSMOKE_SECRET=shh\n");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const envJs = new URL("../src/env.js", import.meta.url).href;
  const dotenv = envPath.replaceAll("\\", "/");
  const code =
    `import { loadEnvFile } from ${JSON.stringify(envJs)};` +
    `loadEnvFile(${JSON.stringify(dotenv)});` +
    `process.stdout.write(process.env.SMOKE_GOOGLE_CLIENT_ID ?? "MISSING");`;

  // Scrubbed environment — the child must get the value from the file alone.
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", code],
    { env: minimalEnv() },
  );
  assert.equal(stdout, "cid-from-dotenv");
});

test("real environment variables always win over .env file values", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "env-override-"));
  const envPath = path.join(directory, ".env");
  await writeFile(envPath, "SMOKE_PRESET=file-value\n");
  t.after(() => rm(directory, { recursive: true, force: true }));

  const envJs = new URL("../src/env.js", import.meta.url).href;
  const dotenv = envPath.replaceAll("\\", "/");
  const code =
    `import { loadEnvFile } from ${JSON.stringify(envJs)};` +
    `loadEnvFile(${JSON.stringify(dotenv)});` +
    `process.stdout.write(process.env.SMOKE_PRESET ?? "MISSING");`;

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "--eval", code],
    { env: minimalEnv({ SMOKE_PRESET: "shell-value" }) },
  );
  assert.equal(stdout, "shell-value");
});

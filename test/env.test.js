import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  envFileCandidates,
  loadEnvFile,
  PACKAGE_ROOT,
  parseEnvFile,
} from "../src/env.js";

test("parses dotenv-style lines with comments, quotes, and exports", () => {
  const parsed = parseEnvFile("\uFEFF" + [
    "",
    "# a comment",
    "GOOGLE_CLIENT_ID=plain-id",
    "export GOOGLE_CLIENT_SECRET = quoted-secret ",
    "YOUTUBE_CREDENTIAL_PASSPHRASE='keep  spaces'",
    'ESCAPED="line\\nbreak"',
    "INLINE=value # trailing comment",
    'QUOTED_WITH_COMMENT="value" # trailing comment',
    "SINGLE_WITH_COMMENT='other' # trailing comment",
    'HASH_INSIDE_QUOTES="keep # this"',
    "EMPTY=",
    "NOT_AN_ASSIGNMENT",
    "   # indented comment",
  ].join("\r\n"));

  assert.equal(parsed.GOOGLE_CLIENT_ID, "plain-id");
  assert.equal(parsed.GOOGLE_CLIENT_SECRET, "quoted-secret");
  assert.equal(parsed.YOUTUBE_CREDENTIAL_PASSPHRASE, "keep  spaces");
  assert.equal(parsed.ESCAPED, "line\nbreak");
  assert.equal(parsed.INLINE, "value");
  assert.equal(parsed.QUOTED_WITH_COMMENT, "value");
  assert.equal(parsed.SINGLE_WITH_COMMENT, "other");
  assert.equal(parsed.HASH_INSIDE_QUOTES, "keep # this");
  assert.equal(parsed.EMPTY, "");
  assert.equal(parsed.NOT_AN_ASSIGNMENT, undefined);
});

test("resolves the working-directory .env before the package-root fallback", () => {
  const cwd = path.join(os.tmpdir(), "env-candidates-cwd");
  const candidates = envFileCandidates({ cwd, env: {}, packageRoot: "/pkg" });
  assert.deepEqual(candidates, [path.resolve(cwd, ".env"), path.resolve("/pkg", ".env")]);

  const same = envFileCandidates({ cwd: PACKAGE_ROOT, env: {}, packageRoot: PACKAGE_ROOT });
  assert.deepEqual(same, [path.resolve(PACKAGE_ROOT, ".env")]);

  const pinned = envFileCandidates({
    cwd,
    env: { MPO_ENV_FILE: "config/.env.local" },
    packageRoot: "/pkg",
  });
  assert.deepEqual(pinned, [path.resolve(cwd, "config/.env.local")]);
});

test("loads .env values without overriding existing environment variables", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "env-load-"));
  try {
    const filePath = path.join(directory, ".env");
    await writeFile(filePath, "GOOGLE_CLIENT_ID=from-file\nEXISTING=from-file\n", "utf8");

    const env = { EXISTING: "from-shell" };
    const result = loadEnvFile({ cwd: directory, env, packageRoot: directory });

    assert.equal(result.loaded, true);
    assert.equal(result.filePath, filePath);
    assert.deepEqual(result.keys, ["GOOGLE_CLIENT_ID"]);
    assert.equal(env.GOOGLE_CLIENT_ID, "from-file");
    assert.equal(env.EXISTING, "from-shell");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("falls back to the package-root .env when the working directory has none", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "env-cwd-"));
  const packageRoot = await mkdtemp(path.join(os.tmpdir(), "env-pkg-"));
  try {
    await writeFile(path.join(packageRoot, ".env"), "YOUTUBE_REGION=JP\n", "utf8");
    const env = {};
    const result = loadEnvFile({ cwd, env, packageRoot });

    assert.equal(result.loaded, true);
    assert.equal(result.filePath, path.join(packageRoot, ".env"));
    assert.equal(env.YOUTUBE_REGION, "JP");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("reports a clean miss when no .env exists", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "env-empty-"));
  try {
    const env = {};
    const result = loadEnvFile({ cwd: directory, env, packageRoot: directory });
    assert.equal(result.loaded, false);
    assert.deepEqual(result.keys, []);
    assert.deepEqual(env, {});
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads a pinned MPO_ENV_FILE and fails loudly when the pin is missing", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "env-pin-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "env-pin-cwd-"));
  try {
    const filePath = path.join(directory, "custom.env");
    await writeFile(filePath, "GOOGLE_CLIENT_ID=pinned\n", "utf8");

    const env = { MPO_ENV_FILE: filePath };
    const result = loadEnvFile({ cwd, env, packageRoot: cwd });
    assert.equal(result.loaded, true);
    assert.equal(result.filePath, filePath);
    assert.equal(env.GOOGLE_CLIENT_ID, "pinned");

    assert.throws(
      () => loadEnvFile({
        cwd,
        env: { MPO_ENV_FILE: path.join(directory, "missing.env") },
        packageRoot: cwd,
      }),
      /MPO_ENV_FILE/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(cwd, { recursive: true, force: true });
  }
});

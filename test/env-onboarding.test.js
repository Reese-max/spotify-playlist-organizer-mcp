import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, resolve } from "node:path";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AUTH_SCRIPT = resolve(root, "scripts/youtube-auth.js");
const SERVER_SCRIPT = resolve(root, "src/server.js");

function cleanEnv(overrides = {}) {
  const keep = ["PATH", "HOME", "USERPROFILE", "APPDATA", "SYSTEMROOT", "COMSPEC", "TEMP", "TMP"];
  const env = {};
  for (const key of keep) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...overrides };
}

async function stopChild(child, exited) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const forceKill = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    await exited.catch(() => {});
  } finally {
    clearTimeout(forceKill);
  }
}

function waitForOutput(child, needle, timeoutMs = 10_000) {
  return new Promise((resolveOutput, reject) => {
    let buffer = "";
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for " + JSON.stringify(needle) + ". Output so far: " + buffer)),
      timeoutMs,
    );
    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.includes(needle)) {
        clearTimeout(timer);
        resolveOutput(buffer);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error("Process exited with " + code + " before emitting " + JSON.stringify(needle) + ". Output: " + buffer));
    });
  });
}

test("npm run youtube:auth reads .env in a clean shell and never prints secrets", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "env-onboarding-"));
  await writeFile(path.join(directory, ".env"), [
    "GOOGLE_CLIENT_ID=onboarding-client-id",
    "GOOGLE_CLIENT_SECRET=onboarding-client-secret",
    "YOUTUBE_CREDENTIAL_PASSPHRASE=onboarding-passphrase",
    "YOUTUBE_OAUTH_REDIRECT_URI=http://127.0.0.1:0/oauth2callback",
    "",
  ].join("\n"), "utf8");

  const child = spawn(process.execPath, [AUTH_SCRIPT], {
    cwd: directory,
    env: cleanEnv({ HOME: directory, USERPROFILE: directory }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exited = once(child, "exit");

  try {
    const output = await waitForOutput(child, "Waiting for the Google OAuth callback");
    assert.match(output, /Loaded environment settings from .*\.env/);
    assert.match(output, /client_id=onboarding-client-id/);
    assert.match(output, /redirect_uri=http%3A%2F%2F127\.0\.0\.1%3A0%2Foauth2callback/);
    assert.doesNotMatch(output, /onboarding-client-secret|onboarding-passphrase/);
    assert.doesNotMatch(stderr, /onboarding-client-secret|onboarding-passphrase/);
  } finally {
    await stopChild(child, exited);
    await rm(directory, { recursive: true, force: true });
  }
});

test("youtube:auth names the missing key and the loaded .env path", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "env-missing-"));
  await writeFile(path.join(directory, ".env"), [
    "GOOGLE_CLIENT_ID=onboarding-client-id",
    "YOUTUBE_CREDENTIAL_PASSPHRASE=onboarding-passphrase",
    "",
  ].join("\n"), "utf8");

  const child = spawn(process.execPath, [AUTH_SCRIPT], {
    cwd: directory,
    env: cleanEnv({ HOME: directory, USERPROFILE: directory }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exited = once(child, "exit");

  try {
    const [code] = await exited;
    assert.equal(code, 1);
    assert.match(stderr, /GOOGLE_CLIENT_SECRET is required/);
    assert.match(stderr, /does not define it|no \.env file was found/);
    assert.doesNotMatch(stderr, /onboarding-passphrase/);
  } finally {
    await stopChild(child, exited);
    await rm(directory, { recursive: true, force: true });
  }
});

test("youtube:auth explains when an empty environment value overrides .env", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "env-empty-var-"));
  await writeFile(path.join(directory, ".env"), [
    "GOOGLE_CLIENT_ID=onboarding-client-id",
    "GOOGLE_CLIENT_SECRET=onboarding-client-secret",
    "YOUTUBE_CREDENTIAL_PASSPHRASE=onboarding-passphrase",
    "",
  ].join("\n"), "utf8");

  const child = spawn(process.execPath, [AUTH_SCRIPT], {
    cwd: directory,
    env: cleanEnv({ HOME: directory, USERPROFILE: directory, GOOGLE_CLIENT_SECRET: "" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const exited = once(child, "exit");

  try {
    const [code] = await exited;
    assert.equal(code, 1);
    assert.match(stderr, /GOOGLE_CLIENT_SECRET is set in the environment but empty/);
    assert.doesNotMatch(stderr, /onboarding-client-secret|onboarding-passphrase/);
  } finally {
    await stopChild(child, exited);
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP stdio server loads the same .env and keeps tokens out of output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "env-mcp-"));
  await writeFile(path.join(directory, ".env"), [
    "YOUTUBE_ACCESS_TOKEN=env-token-should-not-leak",
    "",
  ].join("\n"), "utf8");

  const child = spawn(process.execPath, [SERVER_SCRIPT], {
    cwd: directory,
    env: cleanEnv({ HOME: directory, USERPROFILE: directory }),
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  let stdout = "";
  const exited = once(child, "exit");
  const responses = new Map();
  const waiters = new Map();
  let buffer = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.id !== undefined) {
          if (waiters.has(message.id)) {
            waiters.get(message.id)(message);
            waiters.delete(message.id);
          } else {
            responses.set(message.id, message);
          }
        }
      } catch {
        // Non-JSON output would corrupt stdio framing; the assertions below catch leaks.
      }
    }
  });
  const send = (message) => child.stdin.write(JSON.stringify(message) + "\n");
  const waitFor = (id, timeoutMs = 10_000) => {
    if (responses.has(id)) return Promise.resolve(responses.get(id));
    return new Promise((resolveMessage, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Timed out waiting for response " + id + ". stderr: " + stderr)),
        timeoutMs,
      );
      waiters.set(id, (message) => {
        clearTimeout(timer);
        resolveMessage(message);
      });
    });
  };

  try {
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2026-07-28",
        capabilities: {},
        clientInfo: { name: "env-smoke-test", version: "0.2.0" },
      },
    });
    const initialize = await waitFor(1);
    assert.equal(initialize.result.serverInfo.name, "music-playlist-organizer");

    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "youtube_auth_status", arguments: {} },
    });
    const status = await waitFor(2);
    const payload = JSON.parse(status.result.content[0].text);
    assert.equal(payload.status, "READY");
    assert.equal(payload.source, "environment");
    assert.equal(payload.refreshable, false);
    assert.doesNotMatch(stdout, /env-token-should-not-leak/);
  } finally {
    await stopChild(child, exited);
    await rm(directory, { recursive: true, force: true });
  }
});

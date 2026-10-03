import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { YouTubeClient } from "../src/youtube.js";
import {
  CredentialStore,
  credentialsFromTokenResponse,
  REQUIRED_YOUTUBE_SCOPE,
  scopeCovers,
} from "../src/credentials.js";
import { errorResult, jsonResult, redactSecrets, safeTool } from "../src/redact.js";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import os from "node:os";
import path from "node:path";

const SENTINEL_ACCESS = "SENTINEL_ACCESS_TOKEN_12345";
const SENTINEL_REFRESH = "SENTINEL_REFRESH_TOKEN_67890";
const SENTINEL_CLIENT_SECRET = "SENTINEL_CLIENT_SECRET_ABCDE";
const SENTINEL_AUTH_CODE = "SENTINEL_AUTH_CODE_FGHIJ";
const SENTINEL_PASSPHRASE = "SENTINEL_CREDENTIAL_PASSPHRASE_QRSTU";

function createMockFetch(responses) {
  let callIndex = 0;
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const response = responses[callIndex] || responses[responses.length - 1];
    callIndex++;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      statusText: response.statusText ?? "OK",
      headers: { get: () => null },
      async text() {
        return JSON.stringify(response.body ?? {});
      },
    };
  };
  fetch.calls = calls;
  return fetch;
}

function assertNoSecretsInOutput(output, description) {
  // Error.message/stack are non-enumerable — JSON.stringify(new Error("x"))
  // yields "{}" and would make the sentinel assertions vacuous, so serialize
  // the interesting properties explicitly.
  const outputStr = output instanceof Error
    ? JSON.stringify({
        name: output.name,
        message: output.message,
        code: output.code,
        status: output.status,
        stack: output.stack,
      })
    : JSON.stringify(output);
  assert.doesNotMatch(outputStr, /SENTINEL_ACCESS_TOKEN_12345/, `${description}: access token leaked`);
  assert.doesNotMatch(outputStr, /SENTINEL_REFRESH_TOKEN_67890/, `${description}: refresh token leaked`);
  assert.doesNotMatch(outputStr, /SENTINEL_CLIENT_SECRET_ABCDE/, `${description}: client secret leaked`);
  assert.doesNotMatch(outputStr, /SENTINEL_AUTH_CODE_FGHIJ/, `${description}: auth code leaked`);
  assert.doesNotMatch(outputStr, /SENTINEL_CREDENTIAL_PASSPHRASE_QRSTU/, `${description}: passphrase leaked`);
}

async function withTempStore(env, run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-secret-test-"));
  const filePath = path.join(directory, "youtube-credentials.json");
  try {
    return await run({ ...env, YOUTUBE_CREDENTIAL_FILE: filePath }, filePath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function availableLoopbackPort() {
  const listener = http.createServer();
  await new Promise((resolveListener, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolveListener);
  });
  const { port } = listener.address();
  await new Promise((resolveClose, reject) => listener.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function waitForChildOutput(child, timeoutMs) {
  return new Promise((resolveOutput, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.stderr.off("data", onData);
      child.off("exit", onExit);
    };
    const onData = () => {
      cleanup();
      resolveOutput();
    };
    const onExit = (code) => {
      cleanup();
      reject(new Error("OAuth setup exited before listening; code=" + code));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for OAuth setup output."));
    }, timeoutMs);
    child.stdout.once("data", onData);
    child.stderr.once("data", onData);
    child.once("exit", onExit);
  });
}

async function runFakeOAuthSetup(mode, directory) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const port = await availableLoopbackPort();
  const credentialFile = join(directory, mode + "-credentials.json");
  const fakeFetch = pathToFileURL(join(root, "test", "fixtures", "fake-google-fetch.mjs")).href;
  const child = spawn(process.execPath, ["--import", fakeFetch, join(root, "scripts", "youtube-auth.js")], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
      ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
      ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
      HOME: directory,
      USERPROFILE: directory,
      APPDATA: directory,
      GOOGLE_CLIENT_ID: "fake-client-id.apps.example.test",
      GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
      YOUTUBE_CREDENTIAL_FILE: credentialFile,
      YOUTUBE_CREDENTIAL_PASSPHRASE: SENTINEL_PASSPHRASE,
      YOUTUBE_OAUTH_REDIRECT_URI: "http://127.0.0.1:" + port + "/oauth2callback",
      PROVIDER_TIMEOUT_MS: "2000",
      FAKE_GOOGLE_OAUTH_MODE: mode,
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  let exitResult;
  const exitPromise = once(child, "exit").then(([code, signal]) => {
    exitResult = { code, signal };
    return exitResult;
  });

  try {
    while (!stdout.includes("Waiting for the Google OAuth callback at ")) {
      await waitForChildOutput(child, 5_000);
    }
    const authorizationLine = stdout.match(/https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?[^\r\n]+/);
    assert.ok(authorizationLine, "OAuth authorization URL was not printed");
    const authorization = new URL(authorizationLine[0]);
    assert.ok(authorization.searchParams.get("state"));
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");

    const callbackPath = "/oauth2callback?"
      + new URLSearchParams({
        state: authorization.searchParams.get("state"),
        code: SENTINEL_AUTH_CODE,
      }).toString();
    const callbackStatus = await new Promise((resolveStatus, reject) => {
      const request = http.get({ hostname: "127.0.0.1", port, path: callbackPath }, (response) => {
        response.resume();
        response.once("end", () => resolveStatus(response.statusCode));
      });
      request.once("error", reject);
    });
    assert.equal(callbackStatus, mode === "success" ? 200 : 502);

    let exitTimer;
    const result = await Promise.race([
      exitPromise,
      new Promise((_, reject) => {
        exitTimer = setTimeout(() => reject(new Error("OAuth setup did not exit.")), 5_000);
      }),
    ]).finally(() => clearTimeout(exitTimer));
    return { ...result, stdout, stderr, credentialFile };
  } finally {
    if (!exitResult) child.kill();
    await exitPromise;
  }
}

function storeCredentials(store, overrides = {}) {
  return store.save(credentialsFromTokenResponse({
    access_token: SENTINEL_ACCESS,
    refresh_token: SENTINEL_REFRESH,
    token_type: "Bearer",
    scope: REQUIRED_YOUTUBE_SCOPE,
    expires_in: 3600,
    ...overrides,
  }));
}

test("credentialStatus never exposes secrets in any state", async () => {
  await withTempStore({
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  }, async (env) => {
    const client = new YouTubeClient(env, createMockFetch([
      { body: { access_token: SENTINEL_ACCESS, refresh_token: SENTINEL_REFRESH, expires_in: 3600 } },
    ]));

    await storeCredentials(client.credentials);

    const status = await client.credentialStatus();
    assertNoSecretsInOutput(status, "credentialStatus with stored credentials");
    assert.equal(status.status, "READY");
    assert.ok(!("accessToken" in status));
    assert.ok(!("refreshToken" in status));

    const noCredsClient = new YouTubeClient({ ...env, YOUTUBE_CREDENTIAL_FILE: "/nonexistent" });
    const missingStatus = await noCredsClient.credentialStatus();
    assertNoSecretsInOutput(missingStatus, "credentialStatus with missing credentials");
    assert.equal(missingStatus.status, "MISSING");
  });
});

test("revokeUserCredentials never exposes secrets in output", async () => {
  await withTempStore({
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  }, async (env, filePath) => {
    const client = new YouTubeClient(env, createMockFetch([
      { body: {}, ok: true, status: 200 },
    ]));

    await storeCredentials(client.credentials);

    const result = await client.revokeUserCredentials();
    assertNoSecretsInOutput(result, "revokeUserCredentials");
    assert.equal(result.status, "REVOKED");
    assert.ok(!("token" in result));
    assert.ok(!("accessToken" in result));
    assert.ok(!("refreshToken" in result));

    const restartedClient = new YouTubeClient(env);
    assert.equal((await restartedClient.credentialStatus()).status, "REVOKED");
    const marker = await readFile(filePath + ".status.json", "utf8");
    assert.doesNotMatch(marker, /SENTINEL_ACCESS_TOKEN_12345|SENTINEL_REFRESH_TOKEN_67890/);
  });
});

test("YouTubeClient request errors never leak secrets", async () => {
  const env = {
    YOUTUBE_ACCESS_TOKEN: SENTINEL_ACCESS,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  };

  const client = new YouTubeClient(env, createMockFetch([
    { body: { error: { message: "unauthorized" } }, ok: false, status: 401 },
  ]));

  try {
    await client.request("/search", { query: { q: "test", part: "snippet", type: "video" } });
    assert.fail("Should have thrown");
  } catch (error) {
    assertNoSecretsInOutput(error, "YouTubeClient request error");
    assertNoSecretsInOutput({ message: error.message, code: error.code, status: error.status }, "error properties");
  }
});

test("refreshUserToken error never leaks secrets", async () => {
  await withTempStore({
    YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
  }, async (env) => {
    const client = new YouTubeClient(env, createMockFetch([
      { body: { error: "invalid_grant", error_description: "Token expired" }, ok: false, status: 400 },
    ]));

    await storeCredentials(client.credentials);

    try {
      await client.refreshUserToken();
      assert.fail("Should have thrown");
    } catch (error) {
      assertNoSecretsInOutput(error, "refreshUserToken error");
    }
  });
});

test("MCP tool results never contain secrets", async () => {
  const mockFetch = createMockFetch([
    { body: { pageInfo: { totalResults: 0 }, items: [] } },
    { body: { items: [] } },
  ]);

  const env = { YOUTUBE_API_KEY: "test-key", YOUTUBE_REGION: "TW" };
  const client = new YouTubeClient(env, mockFetch);

  const testTools = [
    { name: "youtube_search_videos", handler: ({ query, limit }) => client.searchVideos(query, { limit }) },
    { name: "youtube_identify_track", handler: ({ input, limit }) => client.searchVideos(input, { limit }) },
    { name: "youtube_list_playlists", handler: ({ limit }) => client.listPlaylists({ limit }) },
    { name: "youtube_auth_status", handler: () => client.credentialStatus() },
  ];

  for (const tool of testTools) {
    const wrappedHandler = safeTool(tool.handler);
    try {
      const result = await wrappedHandler(tool.name === "youtube_search_videos" ? { query: "test", limit: 1 } :
                         tool.name === "youtube_identify_track" ? { input: "test", limit: 1 } :
                         tool.name === "youtube_list_playlists" ? { limit: 1 } : {}, {});
      assertNoSecretsInOutput(result, `MCP tool ${tool.name} result`);
    } catch (error) {
      assertNoSecretsInOutput(error, `MCP tool ${tool.name} error`);
    }
  }
});

test("errorResult never leaks secrets from error objects", () => {
  const errorsWithSecrets = [
    new Error("Failed with " + SENTINEL_ACCESS),
    { message: "Failed with " + SENTINEL_REFRESH, code: "TEST_ERROR" },
    { message: "Failed with " + SENTINEL_CLIENT_SECRET, status: 500, code: "HTTP_5XX" },
    { message: "Failed with " + SENTINEL_AUTH_CODE, retryable: true },
  ];

  for (const error of errorsWithSecrets) {
    const result = errorResult(error);
    assertNoSecretsInOutput(result, "errorResult output");
    assert.ok(result.isError);
  }
});

test("redactSecrets redacts token-shaped values and preserves prose", () => {
  assert.equal(redactSecrets("YOUTUBE_ACCESS_TOKEN=" + SENTINEL_ACCESS), "YOUTUBE_ACCESS_TOKEN=[REDACTED]");
  assert.equal(redactSecrets("refresh_token: " + SENTINEL_REFRESH), "refresh_token: [REDACTED]");
  assert.equal(redactSecrets("Authorization: Bearer " + SENTINEL_ACCESS), "Authorization: [REDACTED]");
  assert.equal(redactSecrets("token is ya29.a0ARrdaM8m_example"), "token is [REDACTED]");
  assert.equal(redactSecrets("client_secret=" + SENTINEL_CLIENT_SECRET), "client_secret=[REDACTED]");
  assert.equal(redactSecrets("code: " + SENTINEL_AUTH_CODE), "code: [REDACTED]");
  assert.equal(redactSecrets("Bearer of Light is a song title"), "Bearer of Light is a song title");
  assert.equal(redactSecrets("no secrets here"), "no secrets here");
});

test("jsonResult redacts secrets inside successful MCP results", () => {
  const result = jsonResult({
    token: SENTINEL_ACCESS,
    nested: { detail: "authorization_code=" + SENTINEL_AUTH_CODE },
    list: ["ya29.a0ARrdaM8m_example", "safe"],
  });
  assertNoSecretsInOutput(result, "jsonResult success output");
  assert.match(result.content[0].text, /\[REDACTED\]/);
});

test("safeTool redacts secrets in both success and error results", async () => {
  const successTool = safeTool(async () => ({ detail: "Bearer " + SENTINEL_ACCESS }));
  const successResult = await successTool({}, {});
  assertNoSecretsInOutput(successResult, "safeTool success result");
  assert.ok(!successResult.isError);

  const errorTool = safeTool(async () => {
    throw new Error("exchange failed for " + SENTINEL_CLIENT_SECRET);
  });
  const errorResultPayload = await errorTool({}, {});
  assert.equal(errorResultPayload.isError, true);
  assertNoSecretsInOutput(errorResultPayload, "safeTool error result");
});

test("CredentialStore load/save/remove never leaks secrets to stdout", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mcp-secret-test-"));
  const filePath = path.join(directory, "youtube-credentials.json");

  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));

  try {
    const env = {
      YOUTUBE_CREDENTIAL_FILE: filePath,
      YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    };
    const store = new CredentialStore(env);

    await storeCredentials(store);

    await store.load();
    await store.remove();

    for (const log of logs) {
      assert.doesNotMatch(log, /SENTINEL_ACCESS_TOKEN_12345/, "console.log leaked access token");
      assert.doesNotMatch(log, /SENTINEL_REFRESH_TOKEN_67890/, "console.log leaked refresh token");
    }
  } finally {
    console.log = originalLog;
    await rm(directory, { recursive: true, force: true });
  }
});

test("credentialStatus with environment fallback never exposes env tokens", async () => {
  await withTempStore({
    YOUTUBE_ACCESS_TOKEN: SENTINEL_ACCESS,
    YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
  }, async (env) => {
    const client = new YouTubeClient(env);
    const status = await client.credentialStatus();

    assertNoSecretsInOutput(status, "credentialStatus with env tokens");
    assert.equal(status.source, "environment");
    assert.ok(!("accessToken" in status));
    assert.ok(!("refreshToken" in status));
    assert.equal(status.refreshable, true);
    assert.equal(status.status, "UNKNOWN");
    assert.equal(status.scopeSufficient, false);
    assert.equal(status.reason, "AUTH_SCOPE_UNKNOWN");
    assert.equal(status.warning, "INSECURE_ENVIRONMENT_FALLBACK");
  });
});

test("revokeUserCredentials with environment tokens never exposes them", async () => {
  const env = {
    YOUTUBE_ACCESS_TOKEN: SENTINEL_ACCESS,
    YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  };

  const client = new YouTubeClient(env, createMockFetch([
    { body: {}, ok: true, status: 200 },
  ]));

  const result = await client.revokeUserCredentials();
  assertNoSecretsInOutput(result, "revokeUserCredentials with env tokens");
  assert.equal(result.status, "REVOKED");
  assert.ok(!("token" in result));
  assert.equal((await client.credentialStatus()).status, "REVOKED");
});

test("YouTubeClient getUserToken errors never leak tokens", async () => {
  await withTempStore({
    YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
  }, async (env) => {
    const client = new YouTubeClient(env, createMockFetch([
      { body: { error: "invalid_grant" }, ok: false, status: 400 },
    ]));

    await storeCredentials(client.credentials);

    try {
      await client.getUserToken();
      assert.fail("Should have thrown");
    } catch (error) {
      assertNoSecretsInOutput(error, "getUserToken error");
    }
  });
});

test("scopeCovers checks granted scopes against the required YouTube scope", () => {
  assert.equal(scopeCovers(REQUIRED_YOUTUBE_SCOPE), true);
  assert.equal(scopeCovers("openid " + REQUIRED_YOUTUBE_SCOPE + " email"), true);
  assert.equal(scopeCovers("openid email"), false);
  assert.equal(scopeCovers("https://www.googleapis.com/auth/youtube.readonly"), false);
  assert.equal(scopeCovers(""), false);
  assert.equal(scopeCovers(null), false);
});

test("stored credentials with insufficient scope fail closed without network calls", async () => {
  await withTempStore({
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  }, async (env) => {
    const mockFetch = createMockFetch([
      { body: { access_token: "unexpected", expires_in: 3600 } },
    ]);
    const client = new YouTubeClient(env, mockFetch);

    await storeCredentials(client.credentials, { scope: "openid email" });

    await assert.rejects(
      client.getUserToken(),
      (error) => error.code === "AUTH_SCOPE_INSUFFICIENT" && error.retryable === false,
    );
    assert.equal(mockFetch.calls.length, 0);

    await assert.rejects(
      client.refreshUserToken(),
      (error) => error.code === "AUTH_SCOPE_INSUFFICIENT",
    );
    assert.equal(mockFetch.calls.length, 0);

    await assert.rejects(
      client.listPlaylists(),
      (error) => error.code === "AUTH_SCOPE_INSUFFICIENT",
    );
    assert.equal(mockFetch.calls.length, 0);
  });
});

test("environment refresh token without a matching scoped grant cannot authorize or be persisted", async () => {
  await withTempStore({
    YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  }, async (env) => {
    const mockFetch = createMockFetch([
      { body: { access_token: "fresh-access", expires_in: 3600 } },
    ]);
    const client = new YouTubeClient(env, mockFetch);

    await assert.rejects(
      client.refreshUserToken(),
      (error) => error.code === "AUTH_SCOPE_UNKNOWN",
    );
    assert.equal(mockFetch.calls.length, 0);
    await assert.rejects(
      client.listPlaylists(),
      (error) => error.code === "AUTH_SCOPE_UNKNOWN",
    );
    assert.equal(mockFetch.calls.length, 0);
    assert.equal((await client.credentialStatus()).status, "UNKNOWN");
    assert.equal(await client.credentials.exists(), false);
  });
});

test("environment access token without a matching grant fails closed", async () => {
  await withTempStore({
    YOUTUBE_ACCESS_TOKEN: SENTINEL_ACCESS,
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  }, async (env) => {
    const mockFetch = createMockFetch([]);
    const client = new YouTubeClient(env, mockFetch);

    await assert.rejects(
      client.getUserToken(),
      (error) => error.code === "AUTH_SCOPE_UNKNOWN" && error.retryable === false,
    );
    const status = await client.credentialStatus();
    assert.equal(status.status, "UNKNOWN");
    assert.equal(status.reason, "AUTH_SCOPE_UNKNOWN");
    assert.equal(status.scopeSufficient, false);
    assert.equal(mockFetch.calls.length, 0);
    assertNoSecretsInOutput(status, "environment access token without a stored grant");
  });
});

test("environment access token with insufficient stored scope fails closed", async () => {
  await withTempStore({
    YOUTUBE_ACCESS_TOKEN: SENTINEL_ACCESS,
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  }, async (env) => {
    const mockFetch = createMockFetch([]);
    const client = new YouTubeClient(env, mockFetch);
    await storeCredentials(client.credentials, {
      scope: "https://www.googleapis.com/auth/youtube.readonly",
    });

    await assert.rejects(
      client.getUserToken(),
      (error) => error.code === "AUTH_SCOPE_INSUFFICIENT" && error.retryable === false,
    );
    const status = await client.credentialStatus();
    assert.equal(status.status, "UNKNOWN");
    assert.equal(status.reason, "AUTH_SCOPE_INSUFFICIENT");
    assert.equal(status.scopeSufficient, false);
    assert.equal(mockFetch.calls.length, 0);
    assertNoSecretsInOutput(status, "environment access token with insufficient stored scope");
  });
});

test("environment access token requires a matching stored grant with YouTube scope", async () => {
  await withTempStore({
    YOUTUBE_ACCESS_TOKEN: SENTINEL_ACCESS,
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  }, async (env) => {
    const mockFetch = createMockFetch([]);
    const client = new YouTubeClient(env, mockFetch);
    await storeCredentials(client.credentials);

    assert.equal(await client.getUserToken(), SENTINEL_ACCESS);
    const status = await client.credentialStatus();
    assert.equal(status.status, "READY");
    assert.equal(status.source, "environment");
    assert.equal(status.scopeSufficient, true);
    assert.equal(status.warning, "INSECURE_ENVIRONMENT_FALLBACK");
    assert.equal(mockFetch.calls.length, 0);
    assertNoSecretsInOutput(status, "verified environment access token status");
  });
});

test("spawned MCP server emits no sentinel secrets in tool results", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "mcp-secret-spawn-"));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MUSIC_LIBRARY_FILE: join(directory, "library.sqlite"),
      YOUTUBE_ACCESS_TOKEN: SENTINEL_ACCESS,
      YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
      YOUTUBE_CREDENTIAL_FILE: join(directory, "nonexistent-credentials.json"),
      YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    },
  });
  const exitPromise = once(child, "exit").catch(() => {});
  let buffer = "";
  const pending = new Map();
  let nextId = 0;
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        pending.get(message.id)(message);
        pending.delete(message.id);
      }
    }
  });
  const send = (method, params) => new Promise((resolveMessage, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for " + method));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolveMessage(message);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });

  try {
    const init = await send("initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "secret-test", version: "0.2.0" },
    });
    assertNoSecretsInOutput(init, "spawned server initialize");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const statusResult = await send("tools/call", { name: "youtube_auth_status", arguments: {} });
    assertNoSecretsInOutput(statusResult, "spawned server youtube_auth_status");
    const text = statusResult.result?.content?.[0]?.text ?? "";
    assert.match(text, /INSECURE_ENVIRONMENT_FALLBACK/);
    assert.match(text, /UNKNOWN/);
    assert.match(text, /AUTH_SCOPE_UNKNOWN/);
  } finally {
    child.kill();
    await exitPromise;
    await rm(directory, { recursive: true, force: true });
  }
});

test("credentialStatus reports insufficient scope as UNKNOWN with a typed reason", async () => {
  await withTempStore({ YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase" }, async (env) => {
    const client = new YouTubeClient(env, createMockFetch([]));

    await storeCredentials(client.credentials, { scope: "openid email" });

    const status = await client.credentialStatus();
    assertNoSecretsInOutput(status, "credentialStatus with insufficient scope");
    assert.equal(status.status, "UNKNOWN");
    assert.equal(status.reason, "AUTH_SCOPE_INSUFFICIENT");
    assert.equal(status.scopeSufficient, false);
    assert.deepEqual(status.grantedScopes, ["openid", "email"]);
    assert.equal(status.requiredScope, REQUIRED_YOUTUBE_SCOPE);
  });
});

test("stored credentials with sufficient scope are used without failing closed", async () => {
  await withTempStore({ YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase" }, async (env) => {
    const client = new YouTubeClient(env, createMockFetch([]));

    await storeCredentials(client.credentials, {
      scope: "openid " + REQUIRED_YOUTUBE_SCOPE,
    });

    assert.equal(await client.getUserToken(), SENTINEL_ACCESS);

    const status = await client.credentialStatus();
    assert.equal(status.status, "READY");
    assert.equal(status.scopeSufficient, true);
  });
});

test("environment refresh token never overwrites a different stored credential", async () => {
  await withTempStore({
    YOUTUBE_REFRESH_TOKEN: "env-supplied-other-account-token",
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  }, async (env) => {
    const mockFetch = createMockFetch([
      { body: { access_token: "env-minted-access", expires_in: 3600 } },
    ]);
    const client = new YouTubeClient(env, mockFetch);

    // The store holds a different account's credential record.
    await storeCredentials(client.credentials);

    await assert.rejects(
      client.refreshUserToken(),
      (error) => error.code === "AUTH_SCOPE_UNKNOWN",
    );
    assert.equal(mockFetch.calls.length, 0);

    const stored = await client.credentials.load();
    assert.equal(stored.refreshToken, SENTINEL_REFRESH);
    assert.equal(stored.accessToken, SENTINEL_ACCESS);
  });
});

test("concurrent refreshUserToken calls share a single token exchange", async () => {
  await withTempStore({
    YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
  }, async (env) => {
    const mockFetch = createMockFetch([
      { body: { access_token: "minted-once", expires_in: 3600 } },
    ]);
    const client = new YouTubeClient(env, mockFetch);
    await storeCredentials(client.credentials);

    const [first, second] = await Promise.all([
      client.refreshUserToken(),
      client.refreshUserToken(),
    ]);
    assert.equal(first, "minted-once");
    assert.equal(second, "minted-once");
    assert.equal(mockFetch.calls.length, 1);
  });
});

test("a store-sourced refresh does not relabel credentialStatus as environment", async () => {
  await withTempStore({
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  }, async (env) => {
    const client = new YouTubeClient(env, createMockFetch([
      { body: { access_token: "minted-access", expires_in: 3600 } },
    ]));

    await storeCredentials(client.credentials);
    assert.equal(await client.refreshUserToken(), "minted-access");

    const status = await client.credentialStatus();
    assert.equal(status.status, "READY");
    assert.ok(!("source" in status) || status.source === "encrypted_file");
    assert.ok(!("warning" in status));
    assert.equal(env.YOUTUBE_ACCESS_TOKEN, undefined);
    assertNoSecretsInOutput(status, "credentialStatus after store refresh");
  });
});

test("revokeUserCredentials deletes an undecryptable store and reports honestly", async () => {
  await withTempStore({}, async (env, filePath) => {
    // Write a record under a passphrase, then revoke without it.
    const writer = new CredentialStore({
      YOUTUBE_CREDENTIAL_FILE: filePath,
      YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    });
    await storeCredentials(writer);

    const mockFetch = createMockFetch([]);
    const client = new YouTubeClient(env, mockFetch);
    const result = await client.revokeUserCredentials();

    assertNoSecretsInOutput(result, "revokeUserCredentials without passphrase");
    assert.equal(result.localCredentialsDeleted, true);
    assert.equal(await client.credentials.exists(), false);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.reason, "CREDENTIAL_PASSPHRASE_REQUIRED");
    // No token was readable, so no remote revoke call may have happened.
    assert.equal(mockFetch.calls.length, 0);
  });
});

test("revokeUserCredentials deletes a store that fails to decrypt", async () => {
  await withTempStore({ YOUTUBE_CREDENTIAL_PASSPHRASE: "wrong-passphrase" }, async (env, filePath) => {
    const writer = new CredentialStore({
      YOUTUBE_CREDENTIAL_FILE: filePath,
      YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    });
    await storeCredentials(writer);

    const mockFetch = createMockFetch([]);
    const client = new YouTubeClient(env, mockFetch);
    const result = await client.revokeUserCredentials();

    assertNoSecretsInOutput(result, "revokeUserCredentials with wrong passphrase");
    assert.equal(result.localCredentialsDeleted, true);
    assert.equal(await client.credentials.exists(), false);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.reason, "CREDENTIAL_DECRYPT_FAILED");
    assert.equal(mockFetch.calls.length, 0);
  });
});

test("redactSecrets keeps JSON parseable when redacting quoted values", () => {
  const redacted = redactSecrets(JSON.stringify({
    accessToken: SENTINEL_ACCESS,
    nested: { refreshToken: SENTINEL_REFRESH },
    safe: "ok",
  }));
  const parsed = JSON.parse(redacted);
  assert.equal(parsed.accessToken, "[REDACTED]");
  assert.equal(parsed.nested.refreshToken, "[REDACTED]");
  assert.equal(parsed.safe, "ok");
  assert.equal(redactSecrets("id_token=abc.def"), "id_token=[REDACTED]");
});

test("credentialStatus exposes a non-secret account fingerprint", async () => {
  await withTempStore({ YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase" }, async (env) => {
    const client = new YouTubeClient(env, createMockFetch([]));

    const record = credentialsFromTokenResponse({
      access_token: SENTINEL_ACCESS,
      refresh_token: SENTINEL_REFRESH,
      scope: REQUIRED_YOUTUBE_SCOPE,
      expires_in: 3600,
    });
    record.channelId = "UC_SENTINEL_CHANNEL";
    record.channelTitle = "Sentinel Channel";
    await client.credentials.save(record);

    const status = await client.credentialStatus();
    assertNoSecretsInOutput(status, "credentialStatus with account fingerprint");
    assert.deepEqual(status.channel, { id: "UC_SENTINEL_CHANNEL", title: "Sentinel Channel" });
  });
});

test("fake OAuth setup keeps sentinels out of captured stdout and stderr", async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "mcp-oauth-output-test-"));
  try {
    for (const mode of ["success", "error"]) {
      const result = await runFakeOAuthSetup(mode, directory);
      assert.equal(result.code, mode === "success" ? 0 : 1);
      assertNoSecretsInOutput(result.stdout, mode + " OAuth stdout");
      assertNoSecretsInOutput(result.stderr, mode + " OAuth stderr");

      if (mode === "success") {
        const credentialFile = await readFile(result.credentialFile, "utf8");
        assert.doesNotMatch(
          credentialFile,
          /SENTINEL_ACCESS_TOKEN_12345|SENTINEL_REFRESH_TOKEN_67890|SENTINEL_CLIENT_SECRET_ABCDE|SENTINEL_AUTH_CODE_FGHIJ|SENTINEL_CREDENTIAL_PASSPHRASE_QRSTU/,
        );
        assert.match(result.stdout, /YouTube OAuth setup completed/);
      } else {
        assert.match(result.stderr, /Token exchange failed/);
        assert.match(result.stderr, /\[REDACTED\]/);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

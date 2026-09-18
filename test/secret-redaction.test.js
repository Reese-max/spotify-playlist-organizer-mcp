import assert from "node:assert/strict";
import test from "node:test";
import { YouTubeClient } from "../src/youtube.js";
import {
  CredentialStore,
  credentialsFromTokenResponse,
  REQUIRED_YOUTUBE_SCOPE,
  scopeCovers,
} from "../src/credentials.js";
import { errorResult, jsonResult, redactSecrets, safeTool } from "../src/redact.js";
import { mkdtemp, rm } from "node:fs/promises";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

const SENTINEL_ACCESS = "SENTINEL_ACCESS_TOKEN_12345";
const SENTINEL_REFRESH = "SENTINEL_REFRESH_TOKEN_67890";
const SENTINEL_CLIENT_SECRET = "SENTINEL_CLIENT_SECRET_ABCDE";
const SENTINEL_AUTH_CODE = "SENTINEL_AUTH_CODE_FGHIJ";

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
  const outputStr = JSON.stringify(output);
  assert.doesNotMatch(outputStr, /SENTINEL_ACCESS_TOKEN_12345/, `${description}: access token leaked`);
  assert.doesNotMatch(outputStr, /SENTINEL_REFRESH_TOKEN_67890/, `${description}: refresh token leaked`);
  assert.doesNotMatch(outputStr, /SENTINEL_CLIENT_SECRET_ABCDE/, `${description}: client secret leaked`);
  assert.doesNotMatch(outputStr, /SENTINEL_AUTH_CODE_FGHIJ/, `${description}: auth code leaked`);
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
  }, async (env) => {
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
  const env = {
    YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  };

  const client = new YouTubeClient(env, createMockFetch([
    { body: { error: "invalid_grant", error_description: "Token expired" }, ok: false, status: 400 },
  ]));

  try {
    await client.refreshUserToken();
    assert.fail("Should have thrown");
  } catch (error) {
    assertNoSecretsInOutput(error, "refreshUserToken error");
  }
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
  const env = {
    YOUTUBE_ACCESS_TOKEN: SENTINEL_ACCESS,
    YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
  };

  const client = new YouTubeClient(env);
  const status = await client.credentialStatus();

  assertNoSecretsInOutput(status, "credentialStatus with env tokens");
  assert.equal(status.source, "environment");
  assert.ok(!("accessToken" in status));
  assert.ok(!("refreshToken" in status));
  assert.ok(status.refreshable);
  assert.equal(status.warning, "INSECURE_ENVIRONMENT_FALLBACK");
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
});

test("YouTubeClient getUserToken errors never leak tokens", async () => {
  const env = {
    YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  };

  const client = new YouTubeClient(env, createMockFetch([
    { body: { error: "invalid_grant" }, ok: false, status: 400 },
  ]));

  try {
    await client.getUserToken();
    assert.fail("Should have thrown");
  } catch (error) {
    assertNoSecretsInOutput(error, "getUserToken error");
  }
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

test("environment refresh token is never persisted into the credential store", async () => {
  await withTempStore({
    YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
    YOUTUBE_CREDENTIAL_PASSPHRASE: "test-passphrase",
    GOOGLE_CLIENT_ID: "test-client-id",
    GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
  }, async (env) => {
    const client = new YouTubeClient(env, createMockFetch([
      { body: { access_token: "fresh-access", expires_in: 3600 } },
    ]));

    assert.equal(await client.refreshUserToken(), "fresh-access");
    assert.equal(await client.credentials.exists(), false);
  });
});

test("spawned MCP server emits no sentinel secrets in tool results", async () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      YOUTUBE_ACCESS_TOKEN: SENTINEL_ACCESS,
      YOUTUBE_REFRESH_TOKEN: SENTINEL_REFRESH,
      GOOGLE_CLIENT_ID: "test-client-id",
      GOOGLE_CLIENT_SECRET: SENTINEL_CLIENT_SECRET,
      YOUTUBE_CREDENTIAL_FILE: "/nonexistent/mcp-secret-test.json",
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
    }, 8_000);
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
    assert.match(text, /READY/);
  } finally {
    child.kill();
    await exitPromise;
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

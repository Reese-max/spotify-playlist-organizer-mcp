import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as httpServer } from "node:http";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspect } from "node:util";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { CredentialStore } from "../src/credentials.js";
import { YouTubeClient } from "../src/youtube.js";
import { createServer } from "../src/server.js";

const SCOPE = "https://www.googleapis.com/auth/youtube";
const ACCESS = "opaque-access-sentinel";
const REFRESH = "opaque-refresh-sentinel";
const SECRET = "opaque-client-sentinel";
const PHRASE = "opaque-passphrase-sentinel";
const CODE = "opaque-code-sentinel";
const secrets = [ACCESS, REFRESH, SECRET, PHRASE, CODE];
const root = resolve(import.meta.dirname, "..");
const response = (data, status = 200) => new globalThis.Response(JSON.stringify(data), { status });

function secretFree(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  for (const secret of secrets) assert.equal(text.includes(secret), false, "secret reached output");
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "youtube-security-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    YOUTUBE_CREDENTIAL_FILE: join(directory, "credentials.json"),
    YOUTUBE_CREDENTIAL_PASSPHRASE: PHRASE,
    GOOGLE_CLIENT_ID: "synthetic-client",
    GOOGLE_CLIENT_SECRET: SECRET,
  };
  const store = new CredentialStore(env);
  await store.save({ accessToken: ACCESS, refreshToken: REFRESH, scope: SCOPE, expiresAt: 1 });
  return { directory, env, store };
}

test("encrypted credential status distinguishes expiry, unknown expiry and restricted scopes", async (t) => {
  const { store } = await fixture(t);
  assert.equal((await store.status()).status, "EXPIRED");
  await store.save({ accessToken: ACCESS, scope: SCOPE, expiresAt: null });
  assert.equal((await store.load()).expiresAt, null);
  assert.equal((await store.status()).status, "UNKNOWN");
  await store.save({ accessToken: ACCESS, scope: SCOPE + ".readonly", expiresAt: Date.now() + 60_000 });
  assert.equal((await store.status()).reason, "AUTH_SCOPE_INSUFFICIENT");
  secretFree(await store.status());
});

for (const scope of [SCOPE + ".readonly", ""]) {
  test("refresh rejects restricted grant before persistence, caching or API use: " + JSON.stringify(scope), async (t) => {
    const { env, store } = await fixture(t);
    const before = await readFile(store.filePath, "utf8");
    let apiCalls = 0;
    const client = new YouTubeClient(env, async (url) => {
      if (url === "https://oauth2.googleapis.com/token") {
        return response({ access_token: "rejected-access", scope, expires_in: 3600 });
      }
      apiCalls += 1;
      return response({ items: [] });
    });
    await assert.rejects(client.listPlaylists(), (error) => {
      assert.equal(error.code, "AUTH_SCOPE_INSUFFICIENT");
      secretFree(String(error));
      return true;
    });
    assert.equal(apiCalls, 0);
    assert.equal(client.env.YOUTUBE_ACCESS_TOKEN, undefined);
    assert.equal(await readFile(store.filePath, "utf8"), before);
  });
}

test("stored restricted grants fail closed before using a fresh token", async (t) => {
  const { env, store } = await fixture(t);
  await store.save({ accessToken: ACCESS, scope: SCOPE + ".readonly", expiresAt: Date.now() + 60_000 });
  let calls = 0;
  const client = new YouTubeClient(env, async () => { calls += 1; return response({ items: [] }); });
  await assert.rejects(client.listPlaylists(), { code: "AUTH_SCOPE_INSUFFICIENT" });
  assert.equal(calls, 0);
});

test("refresh inherits an omitted scope, persists encrypted tokens and revoke deletes them", async (t) => {
  const { env, store } = await fixture(t);
  const client = new YouTubeClient(env, async (url) => {
    if (url.endsWith("/token")) return response({ access_token: "rotated-access", expires_in: 3600 });
    assert.equal(url, "https://oauth2.googleapis.com/revoke");
    return response({});
  });
  assert.equal(await client.getUserToken(), "rotated-access");
  assert.equal((await store.load()).scope, SCOPE);
  assert.equal((await client.credentialStatus()).status, "READY");
  secretFree(await readFile(store.filePath, "utf8"));
  if (process.platform !== "win32") assert.equal((await stat(store.filePath)).mode & 0o777, 0o600);
  const result = await client.revokeUserCredentials();
  assert.equal(result.status, "REVOKED");
  assert.equal(result.localCredentialsDeleted, true);
  assert.equal(await store.exists(), false);
  assert.equal((await client.credentialStatus()).status, "MISSING");
  secretFree(result);
});

test("invalid_grant clears unusable credentials and persists a secret-free REVOKED state", async (t) => {
  const { env, store } = await fixture(t);
  let calls = 0;
  const client = new YouTubeClient(env, async () => {
    calls += 1;
    return response({ error: "invalid_grant", error_description: secrets.join(" ") }, 400);
  });
  await assert.rejects(client.getUserToken(), (error) => {
    assert.equal(error.code, "AUTH_REVOKED");
    secretFree(String(error) + JSON.stringify(error));
    return true;
  });
  assert.equal((await client.credentialStatus()).status, "REVOKED");
  assert.equal((await new YouTubeClient(env).credentialStatus()).status, "REVOKED");
  const revoked = await store.load();
  assert.equal(revoked.accessToken, null);
  assert.equal(revoked.refreshToken, null);
  await assert.rejects(client.getUserToken(), { code: "AUTH_REVOKED" });
  assert.equal(calls, 1);
  const cleanup = await client.revokeUserCredentials();
  assert.equal(cleanup.status, "REVOKED");
  assert.equal(cleanup.localCredentialsDeleted, true);
  assert.equal(await store.exists(), false);
  assert.equal(calls, 1);
});

test("reauthorization replaces a revoked client's cached credentials without restart", async (t) => {
  const { env, store } = await fixture(t);
  const client = new YouTubeClient(env, async () => response({ error: "invalid_grant" }, 400));
  await assert.rejects(client.getUserToken(), { code: "AUTH_REVOKED" });
  await store.save({ accessToken: "reauthorized-access", refreshToken: "reauthorized-refresh", scope: SCOPE, expiresAt: Date.now() + 60_000 });
  assert.equal((await client.credentialStatus()).status, "READY");
  assert.equal(await client.getUserToken(), "reauthorized-access");
});

for (const scope of [undefined, SCOPE]) {
  test("refresh metadata belongs to the token actually used: " + JSON.stringify(scope), async (t) => {
    const { env, store } = await fixture(t);
    const client = new YouTubeClient({ ...env, YOUTUBE_REFRESH_TOKEN: "other-refresh-token" }, async () =>
      response({ access_token: "other-access-token", scope, expires_in: 3600 }));
    if (scope === undefined) {
      await assert.rejects(client.refreshUserToken(), { code: "AUTH_SCOPE_INSUFFICIENT" });
      assert.equal((await store.load()).refreshToken, REFRESH);
    } else {
      assert.equal(await client.refreshUserToken(), "other-access-token");
      assert.equal((await store.load()).refreshToken, "other-refresh-token");
    }
  });
}

test("invalid_grant on an environment override preserves a different stored grant", async (t) => {
  const { env, store } = await fixture(t);
  const before = await readFile(store.filePath, "utf8");
  const client = new YouTubeClient({ ...env, YOUTUBE_REFRESH_TOKEN: "other-refresh-token" }, async () =>
    response({ error: "invalid_grant" }, 400));
  await assert.rejects(client.refreshUserToken(), { code: "AUTH_REVOKED" });
  assert.equal(await readFile(store.filePath, "utf8"), before);
  assert.equal((await store.load()).refreshToken, REFRESH);
});

test("refresh token rotation replaces this client's environment override", async (t) => {
  const { env } = await fixture(t);
  const sent = [];
  const client = new YouTubeClient({ ...env, YOUTUBE_REFRESH_TOKEN: REFRESH }, async (_url, options) => {
    sent.push(options.body.get("refresh_token"));
    return response({ access_token: ACCESS, refresh_token: "rotated-refresh", scope: SCOPE, expires_in: 3600 });
  });
  await client.refreshUserToken();
  await client.refreshUserToken();
  assert.deepEqual(sent, [REFRESH, "rotated-refresh"]);
});

test("a credential read started before revoke cannot restore deleted credentials", async () => {
  let record = { accessToken: ACCESS, refreshToken: REFRESH, scope: SCOPE, expiresAt: Date.now() + 60_000 };
  let release;
  let started;
  const pending = new Promise((resolveRead) => { release = resolveRead; });
  const readStarted = new Promise((resolveStarted) => { started = resolveStarted; });
  let reads = 0;
  const client = new YouTubeClient({}, async () => response({}));
  client.credentials = {
    passphraseConfigured: true,
    exists: async () => record !== null,
    load: async () => {
      if (++reads === 1) { started(); return pending; }
      return record;
    },
    remove: async () => { record = null; return true; },
  };
  const read = client.loadStoredCredentials();
  await readStarted;
  const stale = record;
  assert.equal((await client.revokeUserCredentials()).status, "REVOKED");
  release(stale);
  assert.equal(await read, null);
  assert.equal(client.storedCredentials, null);
  await assert.rejects(client.getUserToken());
});

test("a credential reload started during revoke cannot restore deleted credentials", async () => {
  let record = { accessToken: ACCESS, refreshToken: REFRESH, scope: SCOPE, expiresAt: Date.now() + 60_000 };
  const stale = record;
  let pauseRead = false;
  let releaseRead, readStarted, releaseRevoke, revokeStarted;
  const pendingRead = new Promise((resolveRead) => { releaseRead = resolveRead; });
  const pendingRevoke = new Promise((resolveRevoke) => { releaseRevoke = resolveRevoke; });
  const reading = new Promise((resolveStarted) => { readStarted = resolveStarted; });
  const revoking = new Promise((resolveStarted) => { revokeStarted = resolveStarted; });
  const client = new YouTubeClient({}, async () => { revokeStarted(); return pendingRevoke; });
  client.credentials = {
    passphraseConfigured: true,
    exists: async () => record !== null,
    load: async () => {
      if (pauseRead) { readStarted(); return pendingRead; }
      return record;
    },
    remove: async () => { record = null; return true; },
  };
  const revoke = client.revokeUserCredentials();
  await revoking;
  pauseRead = true;
  const read = client.loadStoredCredentials({ reload: true });
  await reading;
  releaseRevoke(response({}));
  assert.equal((await revoke).status, "REVOKED");
  releaseRead(stale);
  assert.equal(await read, null);
  assert.equal(client.storedCredentials, null);
  await assert.rejects(client.getUserToken());
});

test("redaction includes the trimmed credential values used in requests", async () => {
  const client = new YouTubeClient({ YOUTUBE_ACCESS_TOKEN: "  " + ACCESS + "  " }, async () =>
    response({ error: { message: "rejected " + ACCESS } }, 403));
  await assert.rejects(client.listPlaylists(), (error) => {
    secretFree(inspect(error, { depth: null }));
    return true;
  });
});

test("revoke prevents an in-flight refresh from resurrecting stored credentials", async () => {
  let record = { accessToken: ACCESS, refreshToken: REFRESH, scope: SCOPE, expiresAt: 1 };
  let release;
  let started;
  const pending = new Promise((resolveResponse) => { release = resolveResponse; });
  const tokenStarted = new Promise((resolveStarted) => { started = resolveStarted; });
  const client = new YouTubeClient({ GOOGLE_CLIENT_ID: "synthetic", GOOGLE_CLIENT_SECRET: SECRET }, async (url) => {
    if (url.endsWith("/token")) { started(); return pending; }
    return response({});
  });
  client.credentials = {
    passphraseConfigured: true,
    exists: async () => record !== null,
    load: async () => record,
    save: async (value) => { record = value; },
    remove: async () => { const existed = record !== null; record = null; return existed; },
  };
  const refresh = client.refreshUserToken();
  const settledRefresh = refresh.catch((error) => error);
  await tokenStarted;
  const revoke = client.revokeUserCredentials();
  await new Promise((nextTurn) => setTimeout(nextTurn, 0));
  release(response({ access_token: "late-access", scope: SCOPE, expires_in: 3600 }));
  const [revoked] = await Promise.all([revoke, settledRefresh]);
  assert.equal(revoked.status, "REVOKED");
  assert.equal(record, null);
  assert.equal(client.storedCredentials, null);
});

test("transport errors remain secret-free when inspected for diagnostics", async (t) => {
  const { env } = await fixture(t);
  const client = new YouTubeClient({ ...env, YOUTUBE_ACCESS_TOKEN: ACCESS }, async () => {
    throw new Error(secrets.join(" "));
  });
  await assert.rejects(client.listPlaylists(), (error) => {
    assert.equal(error.code, "NETWORK_ERROR");
    secretFree(inspect(error, { depth: null }));
    return true;
  });
});

for (const error of ["invalid_request", "invalid_token"]) {
  test("revoke only treats an already invalid token as a terminal 400: " + error, async (t) => {
    const { env, store } = await fixture(t);
    const client = new YouTubeClient(env, async () => response({ error }, 400));
    if (error === "invalid_token") {
      assert.equal((await client.revokeUserCredentials()).status, "REVOKED");
      assert.equal(await store.exists(), false);
    } else {
      await assert.rejects(client.revokeUserCredentials(), { code: "AUTH_REVOKE_FAILED" });
      assert.equal(await store.exists(), true);
    }
  });
}

async function mcpCall(server, name, args = {}) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const request = (id, method, params) => new Promise((resolveResponse) => {
    clientTransport.onmessage = (message) => { if (message.id === id) resolveResponse(message); };
    clientTransport.send({ jsonrpc: "2.0", id, method, params });
  });
  await request(1, "initialize", { protocolVersion: "2026-07-28", capabilities: {}, clientInfo: { name: "security-test", version: "1" } });
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  try {
    return await request(2, "tools/call", { name, arguments: args });
  } finally {
    await server.close();
  }
}

test("all MCP success and error fields redact configured credentials and credential-shaped text", async (t) => {
  const { env } = await fixture(t);
  const changes = { ...env, YOUTUBE_ACCESS_TOKEN: ACCESS, YOUTUBE_REFRESH_TOKEN: REFRESH };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const leak = secrets.slice(0, 4).join(" ") + " Bearer ya29.synthetic-leak";
  const success = await mcpCall(createServer({ status: () => ({ nested: [{ message: leak }], refreshToken: "unknown-opaque-token", unchanged: "safe" }) }), "library_status");
  secretFree(success);
  assert.match(success.result.content[0].text, /\[REDACTED\]/);
  assert.equal(JSON.parse(success.result.content[0].text).unchanged, "safe");
  assert.equal(JSON.stringify(success).includes("unknown-opaque-token"), false);
  const failure = await mcpCall(createServer({ status() {
    throw Object.assign(new Error(leak), { code: ACCESS, operation: SECRET, nextStep: REFRESH });
  } }), "library_status");
  assert.equal(failure.result.isError, true);
  secretFree(failure);
});

test("MCP loads file-only credentials and keeps rotated tokens in the redaction context", async (t) => {
  const { env } = await fixture(t);
  const changes = { ...env, YOUTUBE_ACCESS_TOKEN: "", YOUTUBE_REFRESH_TOKEN: "", YOUTUBE_API_KEY: "" };
  const previous = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  const oldFetch = globalThis.fetch;
  Object.assign(process.env, changes);
  t.after(() => {
    globalThis.fetch = oldFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const localResult = await mcpCall(createServer({ status: () => ({ message: ACCESS + " " + REFRESH }) }), "library_status");
  secretFree(localResult);
  globalThis.fetch = async (url) => url === "https://oauth2.googleapis.com/token"
    ? response({ access_token: "rotated-opaque-sentinel", scope: SCOPE, expires_in: 3600 })
    : response({ items: [{ id: "vid12345678", snippet: { title: ACCESS + " rotated-opaque-sentinel" } }] });
  const result = await mcpCall(createServer({}), "youtube_search_videos", { query: "safe" });
  assert.equal(result.result.isError, undefined);
  secretFree(result);
  assert.equal(JSON.stringify(result).includes("rotated-opaque-sentinel"), false);
});

test("credentialStatus keeps unreadable stores UNKNOWN and errors never carry provider secrets", async (t) => {
  const { env } = await fixture(t);
  const wrong = new YouTubeClient({ ...env, YOUTUBE_CREDENTIAL_PASSPHRASE: "wrong" });
  assert.equal((await wrong.credentialStatus()).status, "UNKNOWN");
  const client = new YouTubeClient({ ...env, YOUTUBE_ACCESS_TOKEN: ACCESS }, async () =>
    response({ error: { message: secrets.slice(0, 4).join(" ") } }, 403));
  await assert.rejects(client.listPlaylists(), (error) => {
    secretFree(String(error) + JSON.stringify(error));
    return true;
  });
});

test("clients isolate their auth context and report explicit environment fallback as UNKNOWN", async (t) => {
  const { env } = await fixture(t);
  const shared = { ...env, YOUTUBE_ACCESS_TOKEN: ACCESS, YOUTUBE_REFRESH_TOKEN: REFRESH };
  const first = new YouTubeClient(shared, async () => response({}));
  shared.YOUTUBE_ACCESS_TOKEN = "another-client-token";
  assert.equal(await first.getUserToken(), ACCESS);
  const status = await first.credentialStatus();
  assert.equal(status.status, "UNKNOWN");
  assert.equal(status.reason, "ENVIRONMENT_CREDENTIAL_UNVERIFIED");
  assert.match(status.warning, /development/i);
  await first.revokeUserCredentials();
  assert.equal(shared.YOUTUBE_ACCESS_TOKEN, "another-client-token");
  assert.equal(shared.YOUTUBE_REFRESH_TOKEN, REFRESH);
});

async function oauth(t, { body, status = 200, denied = false, network = false }) {
  const directory = await mkdtemp(join(tmpdir(), "youtube-oauth-security-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const portServer = httpServer();
  portServer.listen(0, "127.0.0.1");
  await once(portServer, "listening");
  const port = portServer.address().port;
  await new Promise((close) => portServer.close(close));
  const preload = join(directory, "oauth-stub.mjs");
  await writeFile(preload, `
    import { createHash } from "node:crypto";
    import { writeFile } from "node:fs/promises";
    globalThis.fetch = async (url, options) => {
      if (url !== "https://oauth2.googleapis.com/token") throw new Error("Unexpected network");
      if (${network}) throw new Error(${JSON.stringify(secrets.join(" "))});
      const form = options.body;
      await writeFile(${JSON.stringify(join(directory, "proof.json"))}, JSON.stringify({
        challenge: createHash("sha256").update(form.get("code_verifier")).digest("base64url"),
        usedCode: form.get("code") === ${JSON.stringify(CODE)}
      }));
      return new Response(${JSON.stringify(JSON.stringify(body))}, { status: ${status} });
    };
  `);
  const filePath = join(directory, "credentials.json");
  const env = {
    PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
    GOOGLE_CLIENT_ID: "synthetic-client", GOOGLE_CLIENT_SECRET: SECRET,
    YOUTUBE_CREDENTIAL_PASSPHRASE: PHRASE, YOUTUBE_CREDENTIAL_FILE: filePath,
    YOUTUBE_OAUTH_REDIRECT_URI: `http://127.0.0.1:${port}/oauth2callback`,
  };
  const child = spawn(process.execPath, ["--import", pathToFileURL(preload).href, join(root, "scripts/youtube-auth.js")], {
    cwd: directory, env, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = once(child, "close");
  t.after(() => { if (child.exitCode === null) child.kill(); });
  let output = "";
  const ready = new Promise((readyResolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OAuth fixture startup timed out")), 10_000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("Waiting for the Google OAuth callback")) {
        clearTimeout(timer);
        readyResolve(new URL(output.match(/https:\/\/accounts\.google\.com\/\S+/)[0]));
      }
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
  });
  const authorization = await ready;
  const callback = new URL(env.YOUTUBE_OAUTH_REDIRECT_URI);
  callback.searchParams.set("state", authorization.searchParams.get("state"));
  callback.searchParams.set(denied ? "error" : "code", denied ? secrets.join(" ") : CODE);
  const reply = await fetch(callback);
  const browser = await reply.text();
  const [exit] = await closed;
  return { output, browser, exit, filePath, authorization, directory, env };
}

test("OAuth PKCE setup stores tokens without process, browser or diagnostic leaks", { timeout: 20_000 }, async (t) => {
  const result = await oauth(t, { body: { access_token: ACCESS, refresh_token: REFRESH, scope: SCOPE, expires_in: 3600 } });
  assert.equal(result.exit, 0);
  assert.match(result.output, /youtube_auth_status/);
  assert.match(result.output, /youtube_auth_revoke/);
  secretFree(result.output + result.browser + await readFile(result.filePath, "utf8"));
  const proof = JSON.parse(await readFile(join(result.directory, "proof.json"), "utf8"));
  assert.equal(result.authorization.searchParams.get("code_challenge_method"), "S256");
  assert.equal(proof.challenge, result.authorization.searchParams.get("code_challenge"));
  assert.equal(proof.usedCode, true);
  secretFree(proof);
});

for (const scope of [undefined, "", SCOPE + ".readonly"]) {
  test("OAuth rejects missing or restricted scopes without writing credentials: " + JSON.stringify(scope), { timeout: 20_000 }, async (t) => {
    const result = await oauth(t, { body: { access_token: ACCESS, refresh_token: REFRESH, scope, expires_in: 3600 } });
    assert.equal(result.exit, 1);
    assert.equal(await new CredentialStore(result.env).exists(), false);
    secretFree(result.output + result.browser);
  });
}

for (const failure of [{ denied: true }, { status: 400 }, { network: true }]) {
  test("OAuth failures never echo callback or token endpoint secrets: " + JSON.stringify(failure), { timeout: 20_000 }, async (t) => {
    const result = await oauth(t, { ...failure, body: { error: "invalid_grant", error_description: secrets.join(" ") } });
    assert.equal(result.exit, 1);
    secretFree(result.output + result.browser);
    assert.equal(await new CredentialStore(result.env).exists(), false);
  });
}

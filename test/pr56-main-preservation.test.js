import assert from "node:assert/strict";
import test from "node:test";
import { errorResult, jsonResult, safeTool } from "../src/redact.js";

test("shared safeTool forwards actual SDK mcpReq.signal without mutating context", async () => {
  const controller = new AbortController();
  const args = { input: "synthetic" };
  const extra = { mcpReq: { signal: controller.signal }, requestId: "synthetic-request" };
  let observed;
  const wrapped = safeTool((value, context) => {
    observed = { value, context };
    return { ok: true };
  });
  assert.deepEqual(JSON.parse((await wrapped(args, extra)).content[0].text), { ok: true });
  assert.equal(observed.value, args);
  assert.equal(observed.context.signal, controller.signal);
  assert.equal(observed.context.mcpReq, extra.mcpReq);
  assert.equal(observed.context.requestId, "synthetic-request");
  assert.equal(extra.signal, undefined);
  assert.notEqual(observed.context, extra);
});

test("shared safeTool preserves explicit signal precedence and original context identity", async () => {
  const direct = new AbortController();
  const nested = new AbortController();
  const extra = { signal: direct.signal, mcpReq: { signal: nested.signal } };
  let observed;
  await safeTool((_, context) => { observed = context; return { ok: true }; })({}, extra);
  assert.equal(observed, extra);
  assert.equal(observed.signal, direct.signal);
});

test("shared safeTool keeps absent SDK context absent", async () => {
  let observed = "not-called";
  await safeTool((_, context) => { observed = context; return { ok: true }; })({});
  assert.equal(observed, undefined);
});

test("shared errorResult retains current-main provider assignment redaction", () => {
  const error = new Error("provider client_id=synthetic-client-123 SID=synthetic-session-123 sk-proj-synthetic12345");
  error.code = "SYNTHETIC_ERROR";
  error.retryable = true;
  error.nextStep = "refresh_token=synthetic-refresh-123";
  const result = errorResult(error);
  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.doesNotMatch(text, /synthetic-client-123|synthetic-session-123|sk-proj-synthetic12345|synthetic-refresh-123/);
  const payload = JSON.parse(text);
  assert.equal(payload.code, "SYNTHETIC_ERROR");
  assert.equal(payload.retryable, true);
  assert.match(payload.error, /\[REDACTED\]/);
  assert.match(payload.nextStep, /\[REDACTED\]/);
});

test("success redaction leaves normal track names and JSON shape intact", () => {
  const value = { title: "Bearer of Light", ids: [1, 2], ready: true, nested: { count: 2 } };
  assert.deepEqual(JSON.parse(jsonResult(value).content[0].text), value);
});

// Criterion #3/#4 refresh-grant controls use only owned encrypted temp files
// and an injected inert fetch. They do not use real Google credentials/network.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CredentialStore, REQUIRED_YOUTUBE_SCOPE } from "../src/credentials.js";
import { YouTubeClient } from "../src/youtube.js";

async function refreshGrantFixture(t, responseScope) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "spotify-refresh-scope-owned-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const env = {
    YOUTUBE_CREDENTIAL_FILE: path.join(directory, "youtube-credentials.json"),
    YOUTUBE_CREDENTIAL_PASSPHRASE: "SYNTHETIC_owned_passphrase",
    GOOGLE_CLIENT_ID: "SYNTHETIC_client",
    GOOGLE_CLIENT_SECRET: "SYNTHETIC_client_secret",
  };
  const store = new CredentialStore(env);
  const original = {
    accessToken: "SYNTHETIC_expired_access",
    refreshToken: "SYNTHETIC_refresh_grant",
    scope: REQUIRED_YOUTUBE_SCOPE,
    expiresAt: Date.now() - 1_000,
  };
  await store.save(original);
  const before = await readFile(store.filePath);
  let refreshCalls = 0;
  const apiCalls = [];
  const client = new YouTubeClient(env, async (url, options) => {
    const address = String(url);
    if (address === "https://oauth2.googleapis.com/token") {
      refreshCalls += 1;
      assert.equal(options.method, "POST");
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), original.refreshToken);
      const data = {
        access_token: "SYNTHETIC_refreshed_access",
        expires_in: 3_600,
        ...responseScope,
      };
      return { ok: true, status: 200, async text() { return JSON.stringify(data); } };
    }
    assert.ok(address.startsWith("https://www.googleapis.com/youtube/v3/playlists"), "no unexpected injected fetch target");
    apiCalls.push({ url: address, headers: options.headers });
    return { ok: true, status: 200, async text() { return JSON.stringify({ items: [] }); } };
  });
  return { client, store, before, original, apiCalls, refreshCalls: () => refreshCalls };
}

async function rejectsChangedRefreshScope(t, scope) {
  const fixture = await refreshGrantFixture(t, { scope });
  await assert.rejects(fixture.client.getUserToken(), {
    code: "AUTH_SCOPE_INSUFFICIENT",
    retryable: false,
  });
  assert.equal(fixture.refreshCalls(), 1);
  assert.equal(fixture.client.mintedAccessToken, null);
  assert.equal(fixture.client.refreshingUserToken, null);
  assert.deepEqual(await readFile(fixture.store.filePath), fixture.before);
  const persisted = await fixture.store.load();
  assert.equal(persisted.scope, REQUIRED_YOUTUBE_SCOPE);
  assert.equal(persisted.accessToken, fixture.original.accessToken);
  // A later real user-authorized request must reject another bad refresh,
  // never reuse an unsafe minted token or dispatch a YouTube API request.
  await assert.rejects(fixture.client.request("/playlists", { auth: "user" }), {
    code: "AUTH_SCOPE_INSUFFICIENT",
    retryable: false,
  });
  assert.equal(fixture.refreshCalls(), 2);
  assert.deepEqual(fixture.apiCalls, []);
  assert.equal(fixture.client.mintedAccessToken, null);
  assert.deepEqual(await readFile(fixture.store.filePath), fixture.before);
}

test("refresh response with narrowed scope rejects before persist, cache or downstream API", async (t) => {
  await rejectsChangedRefreshScope(t, "openid email");
});

test("refresh response with explicit empty scope rejects before persist, cache or downstream API", async (t) => {
  await rejectsChangedRefreshScope(t, "");
});

async function acceptsRefreshScope(t, responseScope) {
  const fixture = await refreshGrantFixture(t, responseScope);
  const tokens = await Promise.all([
    fixture.client.refreshUserToken(),
    fixture.client.refreshUserToken(),
  ]);
  assert.deepEqual(tokens, ["SYNTHETIC_refreshed_access", "SYNTHETIC_refreshed_access"]);
  assert.equal(fixture.refreshCalls(), 1, "the existing single-flight contract remains");
  assert.equal(fixture.client.refreshingUserToken, null);
  assert.equal(await fixture.client.getUserToken(), "SYNTHETIC_refreshed_access");
  assert.equal(fixture.refreshCalls(), 1, "the valid minted token remains reusable");
  const persisted = await fixture.store.load();
  assert.equal(persisted.scope, REQUIRED_YOUTUBE_SCOPE);
  assert.equal(persisted.accessToken, "SYNTHETIC_refreshed_access");
  assert.equal(persisted.refreshToken, fixture.original.refreshToken);
  assert.notDeepEqual(await readFile(fixture.store.filePath), fixture.before);
  assert.deepEqual(await fixture.client.request("/playlists", { auth: "user" }), { items: [] });
  assert.equal(fixture.refreshCalls(), 1);
  assert.equal(fixture.apiCalls.length, 1);
  assert.equal(fixture.apiCalls[0].headers.Authorization, "Bearer SYNTHETIC_refreshed_access");
}

test("refresh response with valid required scope persists and keeps single-flight reuse", async (t) => {
  await acceptsRefreshScope(t, { scope: REQUIRED_YOUTUBE_SCOPE });
});

test("refresh response with omitted scope retains the prior valid grant and single-flight reuse", async (t) => {
  await acceptsRefreshScope(t, {});
});

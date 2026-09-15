import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHttpServer, createSessionStore } from "../src/http-server.js";
import { openLibrary } from "../src/library.js";

const PL_A = "PL_HTTP_TEST_AAAA";
const VID_A = "V_HTTP00001";

class StubYouTube {
  constructor({ hangAdd = false } = {}) {
    this.playlists = new Map();
    this.items = new Map();
    this.videos = new Map();
    this.hangAdd = hangAdd;
    this.addCalls = 0;
  }
  async getPlaylist(id) {
    const playlist = this.playlists.get(id);
    if (!playlist) {
      const error = new Error("not found");
      error.code = "NOT_FOUND";
      throw error;
    }
    return playlist;
  }
  async getPlaylistItems(id) {
    return [...(this.items.get(id) ?? [])];
  }
  async getVideo(id) {
    const video = this.videos.get(id);
    if (!video) {
      const error = new Error("not found");
      error.code = "NOT_FOUND";
      error.status = 404;
      throw error;
    }
    return video;
  }
  async addVideoToPlaylist(playlistId, videoId) {
    this.addCalls += 1;
    if (this.hangAdd) await new Promise((resolve) => setTimeout(resolve, 300));
    const list = this.items.get(playlistId) ?? [];
    if (!list.some((item) => item.id === videoId)) {
      list.push({ id: videoId, name: this.videos.get(videoId)?.name ?? videoId });
    }
    this.items.set(playlistId, list);
    return { added: true };
  }
  async removeVideoFromPlaylist() {
    return { removed: true };
  }
  async searchVideos() {
    return { videos: [...this.videos.values()] };
  }
  async createPlaylist(name) {
    const id = `PL_STUB_${this.playlists.size}`;
    this.playlists.set(id, { id, name });
    this.items.set(id, []);
    return { id, name };
  }
}

async function tempLibrary() {
  const directory = await mkdtemp(path.join(tmpdir(), "music-library-http-"));
  return { directory, filePath: path.join(directory, "library.sqlite") };
}

async function startServer(t, { youtube = new StubYouTube(), ...options } = {}) {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  const server = createHttpServer({
    library,
    youtube,
    bootstrapToken: "test-bootstrap-token",
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    library.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { base, library, youtube, server };
}

async function api(base, method, route, { token, body, origin, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (origin) headers.Origin = origin;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${base}${route}`, {
    method,
    headers,
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
}

async function session(base) {
  const response = await api(base, "POST", "/session", {
    body: { token: "test-bootstrap-token" },
  });
  assert.equal(response.status, 200);
  const { token } = await response.json();
  return token;
}

test("health and version are reachable without a session", async (t) => {
  const { base } = await startServer(t);
  const health = await api(base, "GET", "/health");
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, "ok");
  const version = await api(base, "GET", "/version");
  assert.equal(version.status, 200);
  const body = await version.json();
  assert.equal(body.name, "music-playlist-organizer");
  assert.ok(body.version);
});

test("unauthorized requests cannot read the library or write", async (t) => {
  const { base } = await startServer(t);
  for (const [method, route, body] of [
    ["GET", "/api/library/tracks"],
    ["GET", "/api/library/search?title=x"],
    ["POST", "/api/save_music", { input: "x", videoId: VID_A, mode: "preview" }],
    ["GET", "/api/sync/status"],
    ["POST", "/api/sync", { direction: "push" }],
  ]) {
    const noToken = await api(base, method, route, { body });
    assert.equal(noToken.status, 401, `${method} ${route} without token`);
    const badToken = await api(base, method, route, { body, token: "forged-token" });
    assert.equal(badToken.status, 401, `${method} ${route} with forged token`);
  }
  // The bootstrap endpoint itself rejects wrong bootstrap secrets.
  const forged = await api(base, "POST", "/session", { body: { token: "wrong" } });
  assert.equal(forged.status, 401);
});

test("session bootstrap → authenticated reads and writes share the service layer", async (t) => {
  const { base, library, youtube } = await startServer(t);
  youtube.playlists.set(PL_A, { id: PL_A, name: "HTTP PL" });
  youtube.items.set(PL_A, []);
  youtube.videos.set(VID_A, { id: VID_A, name: "Saved Song" });

  const token = await session(base);

  // save_music preview — no writes.
  const preview = await api(base, "POST", "/api/save_music", {
    token,
    body: { input: "Saved Song", videoId: VID_A, mode: "preview", playlist: PL_A },
  });
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.equal(previewBody.mode, "preview");
  assert.equal(library.trackCount(), 0);
  assert.equal(youtube.addCalls, 0);

  // save_music apply — library + playlist write with receipt.
  const apply = await api(base, "POST", "/api/save_music", {
    token,
    body: { input: "Saved Song", videoId: VID_A, mode: "apply", playlist: PL_A },
  });
  assert.equal(apply.status, 200);
  const applied = await apply.json();
  assert.equal(applied.mode, "apply");
  assert.equal(library.trackCount(), 1);
  assert.equal(youtube.addCalls, 1);

  // Library reads see the same data.
  const list = await api(base, "GET", "/api/library/tracks", { token });
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.total, 1);
  const trackId = listBody.items[0].id;

  const detail = await api(base, "GET", `/api/library/tracks/${trackId}`, { token });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).track.canonicalTitle, "Saved Song");

  // Tag update via HTTP.
  const tags = await api(base, "POST", `/api/library/tracks/${trackId}/tags`, {
    token,
    body: { add: ["http-tag"] },
  });
  assert.equal(tags.status, 200);
  assert.deepEqual((await tags.json()).after, ["http-tag"]);

  // sync_status sees the saved track as in_sync.
  const status = await api(base, "GET", "/api/sync/status", { token });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.summary.in_sync, 1);
});

test("expired and revoked sessions are rejected", async (t) => {
  const { base } = await startServer(t, {
    sessionStore: createSessionStore({ ttlMs: 30 }),
  });
  const token = await session(base);
  await new Promise((resolve) => setTimeout(resolve, 60));
  const expired = await api(base, "GET", "/api/library/tracks", { token });
  assert.equal(expired.status, 401);
});

test("DELETE /session revokes the token immediately", async (t) => {
  const { base } = await startServer(t);
  const token = await session(base);
  const ok = await api(base, "GET", "/api/library/tracks", { token });
  assert.equal(ok.status, 200);
  const revoke = await api(base, "DELETE", "/session", { token });
  assert.equal(revoke.status, 204);
  const after = await api(base, "GET", "/api/library/tracks", { token });
  assert.equal(after.status, 401);
});

test("default-deny origin policy rejects foreign origins, allows configured ones", async (t) => {
  const { base } = await startServer(t, {
    allowedOrigins: ["http://localhost:3000"],
  });
  const token = await session(base);
  const evil = await api(base, "GET", "/api/library/tracks", {
    token,
    origin: "https://evil.example",
  });
  assert.equal(evil.status, 403);
  const good = await api(base, "GET", "/api/library/tracks", {
    token,
    origin: "http://localhost:3000",
  });
  assert.equal(good.status, 200);
  assert.equal(good.headers.get("access-control-allow-origin"), "http://localhost:3000");
});

test("invalid JSON, oversized bodies, and unknown routes get structured errors", async (t) => {
  const { base } = await startServer(t);
  const token = await session(base);

  const badJson = await api(base, "POST", "/api/save_music", {
    token,
    raw: "{not json",
  });
  assert.equal(badJson.status, 400);
  const badBody = await badJson.json();
  assert.equal(badBody.error.code, "BAD_REQUEST");

  const big = await api(base, "POST", "/api/save_music", {
    token,
    raw: JSON.stringify({ input: "x".repeat(200_000) }),
  });
  assert.equal(big.status, 413);

  const missing = await api(base, "GET", "/api/nope", { token });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "NOT_FOUND");
});

test("concurrent effectful requests are bounded with 429", async (t) => {
  const youtube = new StubYouTube({ hangAdd: true });
  const { base } = await startServer(t, { youtube, maxConcurrentWrites: 1 });
  youtube.playlists.set(PL_A, { id: PL_A, name: "HTTP PL" });
  youtube.items.set(PL_A, []);
  youtube.videos.set(VID_A, { id: VID_A, name: "Slow Song" });
  const token = await session(base);

  const payload = { input: "Slow Song", videoId: VID_A, mode: "apply", playlist: PL_A };
  const [first, second] = await Promise.all([
    api(base, "POST", "/api/save_music", { token, body: payload }),
    api(base, "POST", "/api/save_music", { token, body: payload }),
  ]);
  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 429]);
});

test("responses never leak credential material and ignore client-supplied paths", async (t) => {
  const { base, youtube } = await startServer(t);
  youtube.videos.set("CANDIDATE01", { id: "CANDIDATE01", name: "Song A" });
  youtube.videos.set("CANDIDATE02", { id: "CANDIDATE02", name: "Song B" });
  const token = await session(base);
  const response = await api(base, "POST", "/api/save_music", {
    token,
    body: {
      input: "free text with no binding",
      mode: "preview",
      credentialPath: "C:\\secrets\\youtube-token.json",
      env: { YOUTUBE_CREDENTIAL_PASSPHRASE: "hunter2" },
    },
  });
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes("hunter2"), false);
  assert.equal(text.includes("credentialPath"), false);
});

test("reconcile endpoint resolves a track by exact ids over HTTP", async (t) => {
  const { base, library, youtube } = await startServer(t);
  youtube.playlists.set(PL_A, { id: PL_A, name: "HTTP PL" });
  youtube.items.set(PL_A, [{ id: VID_A, name: "Reconciled" }]);
  youtube.videos.set(VID_A, { id: VID_A, name: "Reconciled" });
  const saved = library.upsertTrack({
    title: "Reconciled",
    source: { provider: "youtube", sourceId: VID_A },
    playlist: { provider: "youtube", playlistId: PL_A, name: "HTTP PL" },
  });
  const token = await session(base);
  const response = await api(base, "POST", "/api/reconcile", {
    token,
    body: { trackId: saved.track.id },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sync.state, "synced");
});

import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SECRET_ACCESS_TOKEN = "e2e-secret-access-token";
const SECRET_CLIENT_SECRET = "e2e-secret-client";
const SECRET_PASSPHRASE = "e2e-secret-pass";
const SECRETS = [SECRET_ACCESS_TOKEN, SECRET_CLIENT_SECRET, SECRET_PASSPHRASE];

function videoResource(videoId, title) {
  return {
    id: videoId,
    snippet: {
      title,
      channelTitle: "E2E Channel",
      description: "stub video " + videoId,
      tags: ["e2e"],
      thumbnails: { default: { url: "https://img.example/" + videoId + ".jpg" } },
    },
    contentDetails: { duration: "PT3M30S" },
    status: { privacyStatus: "public" },
    statistics: { viewCount: "1000" },
  };
}

function playlistItemResource(itemId, playlistId, videoId) {
  return {
    id: itemId,
    snippet: {
      playlistId,
      resourceId: { kind: "youtube#video", videoId },
      title: "item-" + videoId,
      channelTitle: "E2E Channel",
    },
    contentDetails: { videoId },
    status: { privacyStatus: "public" },
  };
}

function readBody(req) {
  return new Promise((resolveBody, rejectBody) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => resolveBody(data));
    req.on("error", rejectBody);
  });
}

// In-memory stand-in for the YouTube Data API. `YOUTUBE_API_BASE` points the
// real client at this server, so the E2E path exercises the production
// request/response code with no Google account.
async function startYouTubeStub() {
  const state = {
    videos: new Map(),
    videoFailures: new Map(),
    videoReads: new Map(),
    playlists: new Map(),
    items: new Map(),
    counters: { createPlaylist: 0, addItem: 0, deleteItem: 0, search: 0, getVideo: 0 },
    nextPlaylistId: 1,
    nextItemId: 1,
    failNextAddItem: false,
    failSearchQuota: false,
    failSearchForbidden: false,
    delayAddMs: 0,
  };
  state.addVideo = (videoId, title) => state.videos.set(videoId, videoResource(videoId, title));

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://stub");
      const pathname = url.pathname;
      const sendJson = (code, data) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      const body = req.method === "POST" || req.method === "PUT"
        ? JSON.parse((await readBody(req)) || "{}")
        : null;

      if (req.method === "GET" && pathname === "/videos") {
        state.counters.getVideo += 1;
        const ids = (url.searchParams.get("id") ?? "").split(",");
        for (const id of ids) {
          state.videoReads.set(id, (state.videoReads.get(id) ?? 0) + 1);
          const failure = state.videoFailures.get(id);
          if (failure) return sendJson(failure, { error: { message: "stub video read unavailable" } });
        }
        return sendJson(200, { items: ids.map((id) => state.videos.get(id)).filter(Boolean) });
      }
      if (req.method === "GET" && pathname === "/search") {
        state.counters.search += 1;
        if (state.failSearchQuota) {
          return sendJson(403, {
            error: {
              message: "quota response contains " + SECRET_ACCESS_TOKEN,
              errors: [{ reason: "quotaExceeded" }],
            },
          });
        }
        if (state.failSearchForbidden) {
          return sendJson(403, {
            error: { message: "search forbidden", errors: [{ reason: "forbidden" }] },
          });
        }
        const items = [...state.videos.values()].slice(0, 2).map((video) => ({
          id: { kind: "youtube#video", videoId: video.id },
          snippet: video.snippet,
        }));
        return sendJson(200, { items, pageInfo: { totalResults: items.length } });
      }
      if (req.method === "GET" && pathname === "/playlists") {
        const id = url.searchParams.get("id");
        const items = id
          ? [state.playlists.get(id)].filter(Boolean)
          : [...state.playlists.values()];
        return sendJson(200, { items });
      }
      if (req.method === "POST" && pathname === "/playlists") {
        state.counters.createPlaylist += 1;
        const id = "PLstub" + String(state.nextPlaylistId++).padStart(4, "0");
        const resource = {
          id,
          snippet: {
            title: body?.snippet?.title ?? "",
            description: body?.snippet?.description ?? "",
          },
          status: { privacyStatus: body?.status?.privacyStatus ?? "private" },
          contentDetails: { itemCount: 0 },
        };
        state.playlists.set(id, resource);
        return sendJson(200, resource);
      }
      if (req.method === "GET" && pathname === "/playlistItems") {
        const playlistId = url.searchParams.get("playlistId");
        const items = [...state.items.values()]
          .filter((item) => item.playlistId === playlistId)
          .map((item) => playlistItemResource(item.id, item.playlistId, item.videoId));
        return sendJson(200, { items });
      }
      if (req.method === "POST" && pathname === "/playlistItems") {
        state.counters.addItem += 1;
        if (state.delayAddMs) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, state.delayAddMs));
        }
        const playlistId = body?.snippet?.playlistId;
        const videoId = body?.snippet?.resourceId?.videoId;
        const itemId = "PLIstub" + String(state.nextItemId++).padStart(4, "0");
        // The write lands before the (possibly armed) failure, so a later
        // read-back sees the true provider state — the ambiguity the product
        // contract is built around.
        state.items.set(itemId, { id: itemId, playlistId, videoId });
        if (state.failNextAddItem) {
          state.failNextAddItem = false;
          return sendJson(500, { error: { message: "backend exploded after applying the write" } });
        }
        return sendJson(200, playlistItemResource(itemId, playlistId, videoId));
      }
      if (req.method === "DELETE" && pathname === "/playlistItems") {
        state.counters.deleteItem += 1;
        state.items.delete(url.searchParams.get("id"));
        res.writeHead(204);
        return res.end();
      }
      return sendJson(404, { error: { message: "stub: no route " + req.method + " " + pathname } });
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stub internal: " + error.message } }));
    }
  });

  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  state.url = "http://127.0.0.1:" + server.address().port;
  state.close = () => new Promise((resolveClose) => server.close(resolveClose));
  return state;
}

function spawnMcpServer(directory, apiBase, extraEnv = {}) {
  const child = spawn(process.execPath, [join("src", "server.js")], {
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      SYSTEMROOT: process.env.SYSTEMROOT ?? process.env.SystemRoot ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      USERPROFILE: process.env.USERPROFILE ?? "",
      HOME: process.env.HOME ?? "",
      APPDATA: process.env.APPDATA ?? "",
      MUSIC_LIBRARY_FILE: join(directory, "library.sqlite"),
      YOUTUBE_API_BASE: apiBase,
      YOUTUBE_API_KEY: "e2e-test-api-key",
      YOUTUBE_ACCESS_TOKEN: SECRET_ACCESS_TOKEN,
      GOOGLE_CLIENT_ID: "e2e-client-id",
      GOOGLE_CLIENT_SECRET: SECRET_CLIENT_SECRET,
      YOUTUBE_CREDENTIAL_FILE: join(directory, "no-credentials.json"),
      YOUTUBE_CREDENTIAL_PASSPHRASE: SECRET_PASSPHRASE,
      ...extraEnv,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return child;
}

class McpStdioClient {
  constructor(child) {
    this.child = child;
    this.buffer = "";
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutText = "";
    this.stderrText = "";
    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      this.stdoutText += text;
      this.buffer += text;
      let index;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const slot = this.pending.get(message.id);
        if (slot) {
          this.pending.delete(message.id);
          clearTimeout(slot.timer);
          slot.resolve(message);
        }
      }
    });
    child.stderr.on("data", (chunk) => { this.stderrText += chunk.toString(); });
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error("Timed out waiting for " + method + ". stderr: " + this.stderrText));
      }, 30_000);
      this.pending.set(id, { resolve: resolveRequest, timer });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  async initialize() {
    const response = await this.request("initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.3.0" },
    });
    assert.equal(response.result.serverInfo.name, "music-playlist-organizer");
    this.notify("notifications/initialized", {});
    return response.result;
  }

  async listTools() {
    const response = await this.request("tools/list", {});
    return response.result.tools.map((tool) => tool.name);
  }

  async callTool(name, args) {
    const response = await this.request("tools/call", { name, arguments: args });
    assert.equal(response.jsonrpc, "2.0");
    if (response.error) {
      throw new Error("JSON-RPC error from " + name + ": " + JSON.stringify(response.error));
    }
    const result = response.result;
    const text = (result.content ?? []).find((item) => item.type === "text")?.text ?? "";
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { result, text, parsed };
  }
}

async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  const exited = await Promise.race([
    once(child, "exit").then(() => true).catch(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ]);
  if (!exited) {
    child.kill("SIGKILL");
    await once(child, "exit").catch(() => {});
  }
}

async function startClient(directory, stub) {
  const child = spawnMcpServer(directory, stub.url);
  const client = new McpStdioClient(child);
  try {
    await client.initialize();
    return { child, client };
  } catch (error) {
    await stopServer(child);
    await stub.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function assertNoSecrets(...texts) {
  for (const secret of SECRETS) {
    for (const text of texts) {
      assert.equal(
        text.includes(secret),
        false,
        "secret sentinel " + secret + " leaked into output",
      );
    }
  }
}

test("E2E: overlapping stdio save calls add one playlist row", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "music-mcp-e2e-"));
  const stub = await startYouTubeStub();
  stub.addVideo("vidConcur01", "E2E Concurrent Song");
  stub.playlists.set("PL_CONCURRENT001", {
    id: "PL_CONCURRENT001",
    snippet: { title: "E2E Concurrent" },
    status: { privacyStatus: "private" },
    contentDetails: { itemCount: 0 },
  });
  stub.delayAddMs = 200;
  const { child, client } = await startClient(directory, stub);

  try {
    const args = {
      input: "https://www.youtube.com/watch?v=vidConcur01",
      playlist: "PL_CONCURRENT001",
      mode: "apply",
    };
    const [first, second] = await Promise.all([
      client.callTool("save_music", args),
      client.callTool("save_music", args),
    ]);
    assert.deepEqual([first.parsed.youtube.action, second.parsed.youtube.action].sort(), [
      "added", "skipped_duplicate",
    ]);
    assert.equal(stub.counters.addItem, 1);
    assert.equal([...stub.items.values()].filter((row) => (
      row.playlistId === "PL_CONCURRENT001" && row.videoId === "vidConcur01"
    )).length, 1);
    assertNoSecrets(client.stdoutText, client.stderrText, first.text, second.text);
  } finally {
    await stopServer(child);
    await stub.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("E2E: tools/list exposes the tool surface and exact-URL save persists through stdio", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "music-mcp-e2e-"));
  const stub = await startYouTubeStub();
  stub.addVideo("vidExact001", "E2E Exact Song");
  const { child, client } = await startClient(directory, stub);

  try {
    const tools = await client.listTools();
    for (const name of [
      "save_music", "get_music", "recent_music", "remove_music",
      "sync_status", "reconcile_track", "update_music_classification",
      "list_identity_reviews", "merge_music_tracks",
    ]) {
      assert.ok(tools.includes(name), "tools/list missing " + name);
    }

    const preview = await client.callTool("save_music", {
      input: "https://www.youtube.com/watch?v=vidExact001",
      playlist: "E2E Preview List",
      mode: "preview",
    });
    assert.equal(preview.parsed.action, "would_save");
    assert.equal(preview.parsed.library.writeState, "PREVIEW");
    // Preview must be read-only on the provider.
    assert.equal(stub.counters.createPlaylist, 0);
    assert.equal(stub.counters.addItem, 0);

    const apply = await client.callTool("save_music", {
      input: "https://www.youtube.com/watch?v=vidExact001",
      playlist: "E2E Preview List",
      mode: "apply",
    });
    assert.equal(apply.parsed.action, "saved");
    assert.equal(apply.parsed.library.writeState, "SAVED");
    assert.equal(apply.parsed.youtube.writeState, "SYNCED");
    assert.ok(apply.parsed.ids.trackId > 0);
    assert.ok(apply.parsed.ids.playlistId);
    const trackId = apply.parsed.ids.trackId;
    const playlistId = apply.parsed.ids.playlistId;

    const fetched = await client.callTool("get_music", { trackId });
    assert.equal(fetched.parsed.track.id, trackId);
    assert.equal(fetched.parsed.track.canonicalTitle, "E2E Exact Song");

    const recent = await client.callTool("recent_music", { limit: 10 });
    assert.ok(recent.parsed.items.some((track) => track.id === trackId));

    // Saving the same source again is a duplicate, not a second track or
    // playlist item.
    const duplicate = await client.callTool("save_music", {
      input: "https://www.youtube.com/watch?v=vidExact001",
      playlist: "E2E Preview List",
      mode: "apply",
    });
    assert.equal(duplicate.parsed.action, "skipped_duplicate");
    assert.equal(duplicate.parsed.ids.trackId, trackId);
    assert.equal(stub.counters.addItem, 1);
    assert.equal(
      [...stub.items.values()].filter(
        (item) => item.playlistId === playlistId && item.videoId === "vidExact001",
      ).length,
      1,
    );

    assertNoSecrets(client.stdoutText, client.stderrText, preview.text, apply.text, duplicate.text);
  } finally {
    await stopServer(child);
    await stub.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("E2E: free-text input requires exact videoId selection before any write", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "music-mcp-e2e-"));
  const stub = await startYouTubeStub();
  stub.addVideo("vidSearchA1", "E2E Candidate One");
  stub.addVideo("vidSearchB2", "E2E Candidate Two");
  const { child, client } = await startClient(directory, stub);

  try {
    const ambiguous = await client.callTool("save_music", {
      input: "E2E Candidate",
      mode: "apply",
      syncToYouTube: false,
    });
    assert.equal(ambiguous.parsed.action, "selection_required");
    assert.ok(ambiguous.parsed.candidates.length >= 2);
    // Nothing was written — not even locally.
    assert.equal(ambiguous.parsed.ids.trackId, null);

    const bound = await client.callTool("save_music", {
      input: "E2E Candidate",
      videoId: "vidSearchB2",
      mode: "apply",
      syncToYouTube: false,
    });
    assert.equal(bound.parsed.action, "saved");
    assert.equal(bound.parsed.ids.videoId, "vidSearchB2");
    assert.ok(bound.parsed.ids.trackId > 0);
    assert.equal(bound.parsed.youtube.writeState, "NOT_REQUESTED");

    const recent = await client.callTool("recent_music", { limit: 10 });
    const saved = recent.parsed.items.find((track) => track.id === bound.parsed.ids.trackId);
    assert.equal(saved.canonicalTitle, "E2E Candidate Two");

    assertNoSecrets(client.stdoutText, client.stderrText, ambiguous.text, bound.text);
  } finally {
    await stopServer(child);
    await stub.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("E2E: ambiguous provider write survives restart and resolves via read-back reconcile", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "music-mcp-e2e-"));
  const stub = await startYouTubeStub();
  stub.addVideo("vidAmbig001", "E2E Ambiguous Song");

  const first = await startClient(directory, stub);
  let trackId;
  let playlistId;
  try {
    stub.failNextAddItem = true;
    const apply = await first.client.callTool("save_music", {
      input: "https://www.youtube.com/watch?v=vidAmbig001",
      playlist: "E2E Ambig List",
      mode: "apply",
    });
    assert.equal(apply.parsed.action, "reconciliation_required");
    assert.equal(apply.parsed.youtube.writeState, "UNKNOWN_AFTER_WRITE");
    assert.equal(apply.parsed.syncState, "unknown");
    assert.ok(apply.parsed.nextStep.includes("exact ID") || apply.parsed.nextStep.includes("read"));
    trackId = apply.parsed.ids.trackId;
    playlistId = apply.parsed.ids.playlistId;
    assert.ok(trackId > 0);
    assert.ok(playlistId);
    assertNoSecrets(first.client.stdoutText, first.client.stderrText, apply.text);
  } finally {
    await stopServer(first.child);
  }

  // Fresh process over the same library file — state must come from SQLite.
  const second = await startClient(directory, stub);
  try {
    const status = await second.client.callTool("sync_status", {});
    assert.equal(status.parsed.mode, "status");
    const entry = status.parsed.tracks.find((item) => item.trackId === trackId);
    assert.ok(entry, "sync_status does not see the saved track");

    const reconciled = await second.client.callTool("reconcile_track", { trackId });
    assert.equal(reconciled.parsed.sync.state, "synced");
    assert.ok(
      reconciled.parsed.presence.some(
        (item) => item.playlistId === playlistId && item.videoId === "vidAmbig001" && item.present === true,
      ),
    );

    // Destructive tools still preview without writing.
    const removePreview = await second.client.callTool("remove_music", {
      trackId,
      mode: "preview",
      youtubePlaylist: playlistId,
      videoId: "vidAmbig001",
    });
    assert.equal(stub.counters.deleteItem, 0, "remove_music preview issued a provider DELETE");
    assert.ok(removePreview.text.length > 0);

    const stillThere = await second.client.callTool("get_music", { trackId });
    assert.equal(stillThere.parsed.track.id, trackId);

    assertNoSecrets(second.client.stdoutText, second.client.stderrText, status.text, reconciled.text);
  } finally {
    await stopServer(second.child);
    await stub.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("E2E: search quota exhaustion is typed and exact video IDs remain usable", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "music-mcp-e2e-"));
  const stub = await startYouTubeStub();
  stub.addVideo("vidQuota001", "E2E Quota Song");
  stub.failSearchQuota = true;
  const { child, client } = await startClient(directory, stub);

  try {
    const search = await client.callTool("youtube_search_videos", { query: "E2E Quota Song" });
    assert.equal(search.result.isError, true);
    assert.equal(search.parsed.code, "YOUTUBE_QUOTA_EXCEEDED");
    assert.equal(search.parsed.status, 403);
    assert.equal(search.parsed.operation, "GET /search");
    assert.match(search.parsed.nextStep, /youtube_identify_track.*input.*exact YouTube video URL or 11-character video ID/i);
    assert.equal(stub.counters.search, 1, "quota failure must not be retried");
    assertNoSecrets(search.text);

    const identify = await client.callTool("youtube_identify_track", { input: "E2E Quota Song" });
    assert.equal(identify.parsed.code, "YOUTUBE_QUOTA_EXCEEDED");
    assert.equal(stub.counters.search, 2);

    const exact = await client.callTool("youtube_identify_track", {
      input: "https://www.youtube.com/watch?v=vidQuota001",
    });
    assert.equal(exact.parsed.match.id, "vidQuota001");
    assert.equal(stub.counters.search, 2, "exact URL must bypass search.list");
    assert.equal(stub.counters.getVideo, 1);

    const exactId = await client.callTool("youtube_identify_track", { input: "vidQuota001" });
    assert.equal(exactId.parsed.match.id, "vidQuota001");
    assert.equal(stub.counters.search, 2, "bare video ID must bypass search.list");
    assert.equal(stub.counters.getVideo, 2);

    stub.failSearchQuota = false;
    stub.failSearchForbidden = true;
    const forbidden = await client.callTool("youtube_search_videos", { query: "E2E Quota Song" });
    assert.equal(forbidden.parsed.status, 403);
    assert.notEqual(forbidden.parsed.code, "YOUTUBE_QUOTA_EXCEEDED");
    assert.equal(stub.counters.search, 3);
    assert.equal(stub.counters.addItem, 0);
    assertNoSecrets(client.stdoutText, client.stderrText, identify.text, exact.text, exactId.text, forbidden.text);
  } finally {
    await stopServer(child);
    await stub.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("E2E: batch import retries a transient item through stdio after restart", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "music-mcp-e2e-"));
  const stub = await startYouTubeStub();
  const ids = ["vidBatchA01", "vidBatchB02", "vidBatchC03", "vidBatchD04"];
  stub.addVideo(ids[0], "Morning Sonata");
  stub.addVideo(ids[1], "Quantum Pulse");
  stub.addVideo(ids[2], "Silver Rain");
  stub.addVideo(ids[3], "Private Signal");

  let first;
  let second;
  let batchId;
  let firstReads;
  try {
    first = await startClient(directory, stub);
    const preview = await first.client.callTool("preview_import", { items: ids });
    assert.equal(preview.parsed.mode, "preview");
    assert.equal(preview.parsed.counts.new, 4);
    batchId = preview.parsed.batchId;

    // Verification differs from preview: one read is transient, one source
    // is missing, and one became private. No provider write is requested.
    stub.videoFailures.set(ids[1], 503);
    stub.videos.delete(ids[2]);
    stub.videos.get(ids[3]).status.privacyStatus = "private";
    const partial = await first.client.callTool("import_music_batch", { batchId });
    assert.equal(partial.parsed.action, "partial_failure");
    assert.equal(partial.parsed.remaining, 1);
    const byId = new Map(partial.parsed.results.map((item) => [item.videoId, item]));
    assert.equal(byId.get(ids[0]).status, "imported");
    assert.equal(byId.get(ids[1]).status, "retryable");
    assert.equal(byId.get(ids[1]).error.status, 503);
    assert.equal(byId.get(ids[2]).status, "unavailable");
    assert.equal(byId.get(ids[3]).status, "unavailable");
    assert.match(partial.parsed.nextStep, /resume:true/);

    const status = await first.client.callTool("import_status", { batchId });
    assert.equal(status.parsed.done, 3);
    assert.equal(status.parsed.pending, 1);
    firstReads = new Map(stub.videoReads);
    assert.equal(stub.counters.createPlaylist, 0);
    assert.equal(stub.counters.addItem, 0);
    assertNoSecrets(first.client.stdoutText, first.client.stderrText, preview.text, partial.text, status.text);
    await stopServer(first.child);
    stub.videoFailures.delete(ids[1]);
    second = await startClient(directory, stub);
    const before = await second.client.callTool("import_status", { batchId });
    assert.equal(before.parsed.done, 3);
    assert.equal(before.parsed.pending, 1);

    const resumed = await second.client.callTool("import_music_batch", { batchId, resume: true });
    assert.equal(resumed.parsed.action, "imported");
    assert.equal(resumed.parsed.remaining, 0);
    assert.deepEqual(resumed.parsed.results.map((item) => item.videoId), [ids[1]]);
    assert.equal(resumed.parsed.results[0].status, "imported");
    assert.equal(stub.videoReads.get(ids[0]), firstReads.get(ids[0]));
    assert.equal(stub.videoReads.get(ids[2]), firstReads.get(ids[2]));
    assert.equal(stub.videoReads.get(ids[3]), firstReads.get(ids[3]));
    assert.ok(stub.videoReads.get(ids[1]) > firstReads.get(ids[1]));

    const after = await second.client.callTool("import_status", { batchId });
    assert.equal(after.parsed.done, 4);
    assert.equal(after.parsed.pending, 0);
    const recent = await second.client.callTool("recent_music", { limit: 10 });
    assert.ok(recent.parsed.items.some((item) => item.canonicalTitle === "Morning Sonata"));
    assert.ok(recent.parsed.items.some((item) => item.canonicalTitle === "Quantum Pulse"));
    assert.equal(recent.parsed.items.some((item) => item.canonicalTitle === "Silver Rain"), false);
    assert.equal(recent.parsed.items.some((item) => item.canonicalTitle === "Private Signal"), false);
    assert.equal(stub.counters.addItem, 0);
    assertNoSecrets(second.client.stdoutText, second.client.stderrText, before.text, resumed.text, after.text);
  } finally {
    if (first) await stopServer(first.child);
    if (second) await stopServer(second.child);
    await stub.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("E2E: Spotify MCP tools block before provider calls while result visibility is unknown", { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(os.tmpdir(), "music-mcp-spotify-policy-"));
  const stub = await startYouTubeStub();
  const fetchLog = join(directory, "spotify-fetch-attempts.log");
  const fetchGuard = pathToFileURL(join(root, "test", "fixtures", "deny-spotify-fetch.js")).href;
  const spotifyToken = "synthetic-spotify-access-token-sentinel";
  const child = spawnMcpServer(directory, stub.url, {
    SPOTIFY_ACCESS_TOKEN: spotifyToken,
    SPOTIFY_CLIENT_ID: "synthetic-spotify-client-id",
    SPOTIFY_CLIENT_SECRET: "synthetic-spotify-client-secret",
    SPOTIFY_FETCH_LOG: fetchLog,
    NODE_OPTIONS: "--import=" + fetchGuard,
  });
  const client = new McpStdioClient(child);

  try {
    await client.initialize();
    const listed = await client.request("tools/list", {});
    const organize = listed.result.tools.find((tool) => tool.name === "spotify_organize_playlist");
    assert.deepEqual(organize.inputSchema.properties.mode.enum, ["preview", "apply"]);
    assert.equal(organize.inputSchema.properties.mode.default, "preview");

    const calls = [
      ["spotify_search_tracks", { query: "synthetic boundary query" }],
      ["spotify_identify_track", { input: "synthetic boundary query" }],
      ["spotify_resolve_links", { links: ["synthetic boundary query"] }],
      ["spotify_check_playlist_duplicates", { playlist: "synthetic-playlist-id" }],
      ["spotify_classify_playlist", { playlist: "synthetic-playlist-id" }],
      ["spotify_organize_playlist", { playlist: "synthetic-playlist-id" }],
      ["spotify_organize_playlist", { playlist: "synthetic-playlist-id", mode: "apply" }],
    ];

    const responses = [];
    for (const [toolName, args] of calls) {
      const response = await client.callTool(toolName, args);
      responses.push(response.text);
      assert.equal(response.result.isError, true, toolName + " must fail closed");
      assert.equal(response.parsed.code, "SPOTIFY_CONTENT_VISIBILITY_UNKNOWN");
      assert.equal(response.parsed.error, "Spotify results are disabled by the provider-data policy guard.");
      assert.ok(response.parsed.nextStep.includes("spotify-ai-boundary.md"));
      assert.equal(response.text.includes(spotifyToken), false);
      assert.equal(response.text.includes("synthetic boundary query"), false);
    }

    assertNoSecrets(client.stdoutText, client.stderrText, ...responses);
    await stopServer(child);
    const attempts = await readFile(fetchLog, "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    assert.equal(attempts, "", "preflight must prevent Spotify token or API requests");
  } finally {
    await stopServer(child);
    await stub.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VIDEO_ID = "dQw4w9WgXcQ";
const VIDEO_URL = "https://youtu.be/" + VIDEO_ID;
const ACCESS_TOKEN = "issue4-test-token";

function writeJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function videoResource(id) {
  return {
    id,
    snippet: {
      title: "Focus Piano",
      channelTitle: "Example Channel",
      description: "A focused track",
    },
    contentDetails: { videoId: id },
    statistics: { viewCount: "1" },
  };
}

function playlistResource(playlist) {
  return {
    id: playlist.id,
    snippet: { title: playlist.name, description: playlist.description ?? "" },
    status: { privacyStatus: playlist.privacyStatus ?? "private" },
    contentDetails: { itemCount: playlist.itemCount ?? 0 },
  };
}

function playlistItemResource(videoId) {
  return {
    snippet: {
      title: "Focus Piano",
      channelTitle: "Example Channel",
      resourceId: { kind: "youtube#video", videoId },
    },
    contentDetails: { videoId },
  };
}

// A local stand-in for the YouTube Data API. `overrides` maps
// "METHOD /path" to (call, res, ctx) => void; returning without ending the
// response simulates a lost provider response.
function startYouTubeStub({ playlists = [], items = {}, overrides = {} } = {}) {
  const calls = [];
  let created = 0;
  const ctx = { playlists, items };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const url = new URL(req.url, "http://stub.local");
      const call = {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        body: raw ? JSON.parse(raw) : null,
        authorization: req.headers.authorization ?? null,
      };
      calls.push(call);

      const override = overrides[req.method + " " + url.pathname];
      if (override) return override(call, res, ctx);

      if (req.method === "GET" && url.pathname === "/videos") {
        return writeJson(res, 200, { items: [videoResource(call.query.id)] });
      }
      if (req.method === "GET" && url.pathname === "/playlists") {
        if (call.query.id) {
          const found = ctx.playlists.find((playlist) => playlist.id === call.query.id);
          return writeJson(res, 200, { items: found ? [playlistResource(found)] : [] });
        }
        return writeJson(res, 200, { items: ctx.playlists.map(playlistResource) });
      }
      if (req.method === "GET" && url.pathname === "/playlistItems") {
        const videoIds = ctx.items[call.query.playlistId] ?? [];
        return writeJson(res, 200, { items: videoIds.map(playlistItemResource) });
      }
      if (req.method === "POST" && url.pathname === "/playlists") {
        created += 1;
        const playlist = {
          id: "PL_CREATED_" + String(created).padStart(4, "0") + "_TEST",
          name: call.body.snippet.title,
          privacyStatus: call.body.status?.privacyStatus ?? "private",
        };
        ctx.playlists.push(playlist);
        return writeJson(res, 200, playlistResource(playlist));
      }
      if (req.method === "POST" && url.pathname === "/playlistItems") {
        const videoId = call.body.snippet.resourceId.videoId;
        const playlistId = call.body.snippet.playlistId;
        (ctx.items[playlistId] ??= []).push(videoId);
        return writeJson(res, 200, {
          id: "item-" + videoId,
          snippet: {
            title: "Focus Piano",
            channelTitle: "Example Channel",
            playlistId,
            resourceId: { kind: "youtube#video", videoId },
          },
        });
      }
      return writeJson(res, 404, { error: { message: "Unhandled stub route: " + req.method + " " + url.pathname } });
    });
  });

  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => {
      resolveStart({
        server,
        calls,
        ctx,
        baseUrl: "http://127.0.0.1:" + server.address().port,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(done);
        }),
      });
    });
  });
}

class McpStdioClient {
  constructor(env) {
    this.child = spawn(process.execPath, ["src/server.js"], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        YOUTUBE_API_KEY: "",
        YOUTUBE_ACCESS_TOKEN: ACCESS_TOKEN,
        YOUTUBE_REFRESH_TOKEN: "",
        YOUTUBE_CREDENTIAL_FILE: resolve(root, "test", ".nonexistent-credentials.json"),
        YOUTUBE_CREDENTIAL_PASSPHRASE: "",
        PROVIDER_TIMEOUT_MS: "400",
        PROVIDER_MAX_READ_RETRIES: "0",
        ...env,
      },
    });
    this.stderr = "";
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => { this.stderr += chunk; });
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf("\n");
      while (index >= 0) {
        const line = this.buffer.slice(0, index).trim();
        this.buffer = this.buffer.slice(index + 1);
        index = this.buffer.indexOf("\n");
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (message.id === undefined || !this.pending.has(message.id)) continue;
        const { resolveRequest, rejectRequest, timer } = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(timer);
        if (message.error) {
          rejectRequest(new Error("MCP error " + message.error.code + ": " + message.error.message));
        } else {
          resolveRequest(message.result);
        }
      }
    });
  }

  request(method, params, { timeoutMs = 10_000 } = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error("Timed out waiting for " + method + ". stderr: " + this.stderr));
      }, timeoutMs);
      this.pending.set(id, { resolveRequest, rejectRequest, timer });
      this.child.stdin.write(JSON.stringify(payload) + "\n");
    });
  }

  notify(method) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  }

  async connect() {
    const result = await this.request("initialize", {
      protocolVersion: "2026-07-28",
      capabilities: {},
      clientInfo: { name: "save-flow-test", version: "0.2.0" },
    });
    this.notify("notifications/initialized");
    return result;
  }

  async callTool(name, args) {
    const result = await this.request("tools/call", { name, arguments: args });
    const text = result.content?.[0]?.text ?? "";
    return {
      isError: Boolean(result.isError),
      payload: text ? JSON.parse(text) : null,
      raw: JSON.stringify(result),
    };
  }

  async close() {
    const child = this.child;
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.stdin.end();
    child.kill();
    const fallback = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try {
      await once(child, "exit").catch(() => {});
    } finally {
      clearTimeout(fallback);
    }
  }
}

async function withServer(stub, run) {
  const client = new McpStdioClient({ YOUTUBE_API_BASE_URL: stub.baseUrl });
  try {
    await client.connect();
    await run(client);
  } finally {
    await client.close();
  }
}

function writeCalls(calls) {
  return calls.filter((call) => call.method === "POST");
}

test("youtube_save_track apply adds a video to an existing playlist", { timeout: 20_000 }, async () => {
  const stub = await startYouTubeStub({
    playlists: [{ id: "PL_EXISTING_0001_TEST", name: "Chill" }],
  });
  try {
    await withServer(stub, async (client) => {
      const { isError, payload } = await client.callTool("youtube_save_track", {
        input: VIDEO_URL,
        category: "Chill",
        mode: "apply",
      });
      assert.equal(isError, false);
      assert.equal(payload.action, "added");
      assert.equal(payload.playlist.id, "PL_EXISTING_0001_TEST");
      assert.equal(payload.playlistAction, "use_existing");
      assert.equal(payload.video.id, VIDEO_ID);
      const adds = writeCalls(stub.calls).filter((call) => call.path === "/playlistItems");
      assert.equal(adds.length, 1);
      assert.equal(adds[0].body.snippet.playlistId, "PL_EXISTING_0001_TEST");
      assert.ok(adds[0].authorization === "Bearer " + ACCESS_TOKEN);
      assert.equal(stub.calls.some((call) => call.path === "/playlists" && call.method === "POST"), false);
    });
  } finally {
    await stub.close();
  }
});

test("youtube_save_track returns PARTIAL_PLAYLIST_CREATED when add fails after a confirmed create", { timeout: 20_000 }, async () => {
  const stub = await startYouTubeStub({
    overrides: {
      "POST /playlistItems": (call, res) => writeJson(res, 403, {
        error: { message: "The request cannot be completed.", errors: [{ reason: "forbidden" }] },
      }),
    },
  });
  try {
    await withServer(stub, async (client) => {
      const { isError, payload, raw } = await client.callTool("youtube_save_track", {
        input: VIDEO_URL,
        category: "Chill",
        mode: "apply",
      });
      assert.equal(isError, false);
      assert.equal(payload.action, "reconciliation_required");
      assert.equal(payload.writeState, "PARTIAL_PLAYLIST_CREATED");
      assert.match(payload.playlist.id, /^PL_CREATED_\d+_TEST$/);
      assert.equal(payload.playlist.url, "https://www.youtube.com/playlist?list=" + payload.playlist.id);
      assert.equal(payload.videoId, VIDEO_ID);
      assert.deepEqual(payload.completedSteps, ["playlist_created"]);
      assert.equal(typeof payload.nextStep, "string");
      assert.ok(payload.nextStep.length > 0);
      assert.equal(payload.error.status, 403);
      assert.equal(raw.includes(ACCESS_TOKEN), false);
      const posts = writeCalls(stub.calls);
      assert.equal(posts.filter((call) => call.path === "/playlists").length, 1);
      assert.equal(posts.filter((call) => call.path === "/playlistItems").length, 1);
    });
  } finally {
    await stub.close();
  }
});

test("youtube_save_track returns UNKNOWN_AFTER_WRITE when the add response is lost", { timeout: 20_000 }, async () => {
  const stub = await startYouTubeStub({
    overrides: {
      "POST /playlistItems": () => {},
    },
  });
  try {
    await withServer(stub, async (client) => {
      const { isError, payload } = await client.callTool("youtube_save_track", {
        input: VIDEO_URL,
        category: "Chill",
        mode: "apply",
      });
      assert.equal(isError, false);
      assert.equal(payload.action, "reconciliation_required");
      assert.equal(payload.writeState, "UNKNOWN_AFTER_WRITE");
      assert.match(payload.playlist.id, /^PL_CREATED_\d+_TEST$/);
      assert.deepEqual(payload.completedSteps, ["playlist_created"]);
      assert.equal(payload.videoId, VIDEO_ID);
      assert.equal(payload.error.code, "TIMEOUT");
    });
  } finally {
    await stub.close();
  }
});

test("retry with exact IDs skips the video already confirmed in the playlist", { timeout: 20_000 }, async () => {
  const playlistId = "PL_CONFIRMED_0001_TEST";
  const stub = await startYouTubeStub({
    playlists: [{ id: playlistId, name: "Chill" }],
    items: { [playlistId]: [VIDEO_ID] },
  });
  try {
    await withServer(stub, async (client) => {
      const { isError, payload } = await client.callTool("youtube_save_track", {
        input: VIDEO_URL,
        videoId: VIDEO_ID,
        playlist: playlistId,
        mode: "apply",
      });
      assert.equal(isError, false);
      assert.equal(payload.action, "skipped_duplicate");
      assert.equal(payload.playlist.id, playlistId);
      assert.equal(stub.calls.some((call) => call.path === "/playlistItems" && call.method === "GET"), true);
      assert.equal(writeCalls(stub.calls).length, 0);
    });
  } finally {
    await stub.close();
  }
});

test("retry with exact IDs adds to the confirmed playlist without recreating it", { timeout: 20_000 }, async () => {
  const playlistId = "PL_CONFIRMED_0002_TEST";
  const stub = await startYouTubeStub({
    playlists: [{ id: playlistId, name: "Chill" }],
    items: { [playlistId]: [] },
  });
  try {
    await withServer(stub, async (client) => {
      const { isError, payload } = await client.callTool("youtube_save_track", {
        input: VIDEO_URL,
        videoId: VIDEO_ID,
        playlist: playlistId,
        mode: "apply",
      });
      assert.equal(isError, false);
      assert.equal(payload.action, "added");
      assert.equal(payload.playlist.id, playlistId);
      const posts = writeCalls(stub.calls);
      assert.equal(posts.filter((call) => call.path === "/playlists").length, 0);
      const adds = posts.filter((call) => call.path === "/playlistItems");
      assert.equal(adds.length, 1);
      assert.equal(adds[0].body.snippet.playlistId, playlistId);
      assert.equal(adds[0].body.snippet.resourceId.videoId, VIDEO_ID);
    });
  } finally {
    await stub.close();
  }
});

test("retry does not write blindly when the playlist read-back fails", { timeout: 20_000 }, async () => {
  const playlistId = "PL_CONFIRMED_0003_TEST";
  const stub = await startYouTubeStub({
    playlists: [{ id: playlistId, name: "Chill" }],
    overrides: {
      "GET /playlistItems": () => {},
    },
  });
  try {
    await withServer(stub, async (client) => {
      const { isError, payload } = await client.callTool("youtube_save_track", {
        input: VIDEO_URL,
        videoId: VIDEO_ID,
        playlist: playlistId,
        mode: "apply",
      });
      assert.equal(isError, true);
      assert.equal(payload.code, "TIMEOUT");
      assert.equal(writeCalls(stub.calls).length, 0);
    });
  } finally {
    await stub.close();
  }
});

test("an exact playlist ID that no longer exists fails without creating or renaming", { timeout: 20_000 }, async () => {
  const playlistId = "PL_MISSING_00004_TEST";
  const stub = await startYouTubeStub();
  try {
    await withServer(stub, async (client) => {
      const { isError, payload } = await client.callTool("youtube_save_track", {
        input: VIDEO_URL,
        videoId: VIDEO_ID,
        playlist: playlistId,
        mode: "apply",
      });
      assert.equal(isError, true);
      assert.match(payload.error, new RegExp(playlistId));
      assert.equal(writeCalls(stub.calls).length, 0);
      assert.equal(
        stub.calls.some((call) => call.path === "/playlists" && call.query.mine === "true"),
        false,
      );
    });
  } finally {
    await stub.close();
  }
});

test("youtube_save_track preview performs no writes", { timeout: 20_000 }, async () => {
  const stub = await startYouTubeStub();
  try {
    await withServer(stub, async (client) => {
      const { isError, payload } = await client.callTool("youtube_save_track", {
        input: VIDEO_URL,
        category: "Chill",
        mode: "preview",
      });
      assert.equal(isError, false);
      assert.equal(payload.action, "would_add");
      assert.equal(payload.playlistAction, "create_if_missing");
      assert.equal(writeCalls(stub.calls).length, 0);
    });
  } finally {
    await stub.close();
  }
});

test("youtube_add_to_playlist returns FAILED_NO_CONFIRMED_EFFECT when an existing playlist rejects the add", { timeout: 20_000 }, async () => {
  const playlistId = "PL_EXISTING_0002_TEST";
  const stub = await startYouTubeStub({
    playlists: [{ id: playlistId, name: "Chill" }],
    items: { [playlistId]: [] },
    overrides: {
      "POST /playlistItems": (call, res) => writeJson(res, 400, {
        error: { message: "The video is unavailable.", errors: [{ reason: "videoNotFound" }] },
      }),
    },
  });
  try {
    await withServer(stub, async (client) => {
      const { isError, payload } = await client.callTool("youtube_add_to_playlist", {
        input: VIDEO_URL,
        playlist: playlistId,
        mode: "apply",
      });
      assert.equal(isError, false);
      assert.equal(payload.action, "reconciliation_required");
      assert.equal(payload.writeState, "FAILED_NO_CONFIRMED_EFFECT");
      assert.equal(payload.playlist.id, playlistId);
      assert.equal(payload.video.id, VIDEO_ID);
      assert.deepEqual(payload.completedSteps, []);
    });
  } finally {
    await stub.close();
  }
});

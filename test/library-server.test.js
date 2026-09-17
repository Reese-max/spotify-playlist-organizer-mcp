import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  InMemoryTransport,
  LATEST_PROTOCOL_VERSION,
} from "@modelcontextprotocol/server";
import { LibraryStore } from "../src/library.js";

process.env.YOUTUBE_ACCESS_TOKEN = "test-user-token";

function ok(data) {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(data);
    },
  };
}

// The module-level YouTubeClient captures globalThis.fetch at import time.
globalThis.fetch = async (url, options = {}) => {
  const method = options.method ?? "GET";
  const pathname = new URL(url).pathname;
  if (pathname.endsWith("/videos")) {
    return ok({
      items: [{
        id: "dQw4w9WgXcQ",
        snippet: { title: "One More Time", channelTitle: "Daft Punk" },
        contentDetails: { duration: "PT5M20S" },
      }],
    });
  }
  if (pathname.endsWith("/playlists")) {
    if (method === "POST") {
      return ok({
        id: "PL_NEW",
        snippet: { title: JSON.parse(options.body).snippet.title },
        status: { privacyStatus: "private" },
        contentDetails: { itemCount: 0 },
      });
    }
    return ok({
      items: [{
        id: "PL_CHILL",
        snippet: { title: "Chill" },
        status: { privacyStatus: "private" },
        contentDetails: { itemCount: 1 },
      }],
    });
  }
  if (pathname.endsWith("/playlistItems")) {
    if (method === "POST") {
      return ok({
        id: "item-1",
        snippet: { title: "One More Time", resourceId: { videoId: "dQw4w9WgXcQ" } },
        contentDetails: { videoId: "dQw4w9WgXcQ" },
      });
    }
    return ok({ items: [] });
  }
  return ok({});
};

const { createServer } = await import("../src/server.js");

async function connectServer(options = {}) {
  const server = createServer(options);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  let nextId = 0;
  clientTransport.onmessage = (message) => {
    if (message.id === undefined) return;
    const resolve = pending.get(message.id);
    if (resolve) {
      pending.delete(message.id);
      resolve(message);
    }
  };
  await server.connect(serverTransport);
  await clientTransport.start();

  const call = (method, params) => new Promise((resolvePromise, reject) => {
    const id = (nextId += 1);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("Timed out waiting for " + method));
    }, 5_000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolvePromise(message);
    });
    clientTransport.send({ jsonrpc: "2.0", id, method, params }).catch((error) => {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    });
  });

  const init = await call("initialize", {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "library-server-test", version: "0.2.0" },
  });
  assert.equal(init.result.serverInfo.name, "music-playlist-organizer");
  await clientTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const callTool = async (name, args) => {
    const message = await call("tools/call", { name, arguments: args });
    assert.equal(message.error, undefined, JSON.stringify(message.error));
    return JSON.parse(message.result.content[0].text);
  };

  return {
    callTool,
    close: async () => {
      await clientTransport.close();
      await server.close();
    },
  };
}

async function tempDir() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "library-server-"));
  return { directory, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

test("youtube_save_track apply records the track in the local library", async () => {
  const { directory, cleanup } = await tempDir();
  const dbPath = path.join(directory, "library.db");
  const library = new LibraryStore({}, dbPath);
  const { callTool, close } = await connectServer({ library });
  try {
    const preview = await callTool("youtube_save_track", {
      input: "unused when videoId is set",
      videoId: "dQw4w9WgXcQ",
      playlist: "Chill",
      category: "Chill",
      mode: "preview",
    });
    assert.equal(preview.action, "would_add");
    assert.equal(preview.library.status, "READY");
    assert.equal(preview.library.existingTrackId, null);
    assert.equal(library.status().counts.tracks, 0);

    const applied = await callTool("youtube_save_track", {
      input: "unused when videoId is set",
      videoId: "dQw4w9WgXcQ",
      playlist: "Chill",
      category: "Chill",
      mode: "apply",
    });
    assert.equal(applied.action, "added");
    assert.equal(applied.library.status, "RECORDED");
    assert.equal(applied.library.created, true);
    assert.ok(applied.library.trackId >= 1);

    const status = await callTool("library_status", {});
    assert.equal(status.status, "READY");
    assert.equal(status.counts.tracks, 1);
  } finally {
    await close();
    library.close();
  }

  const reopened = new LibraryStore({}, dbPath);
  const track = reopened.findTrackByVideoId("dQw4w9WgXcQ");
  assert.equal(track.title, "One More Time");
  assert.equal(track.artist, "Daft Punk");
  const full = reopened.getTrack(track.id);
  assert.deepEqual(full.tags, ["Chill"]);
  assert.equal(full.playlists[0].providerPlaylistId, "PL_CHILL");
  assert.equal(full.sync[0].status, "synced");
  reopened.close();
  await cleanup();
});

test("a failed library write reports a readable partial state instead of fake success", async () => {
  const { directory, cleanup } = await tempDir();
  // Pointing the database at an existing directory makes open() fail.
  const brokenLibrary = new LibraryStore({}, directory);
  const { callTool, close } = await connectServer({ library: brokenLibrary });
  try {
    const applied = await callTool("youtube_save_track", {
      input: "unused when videoId is set",
      videoId: "dQw4w9WgXcQ",
      playlist: "Chill",
      category: "Chill",
      mode: "apply",
    });
    assert.equal(applied.action, "added");
    assert.equal(applied.library.status, "FAILED");
    assert.equal(applied.library.error.code, "LIBRARY_OPEN_FAILED");
    assert.match(applied.library.error.message, /local music library/);

    const status = await callTool("library_status", {});
    assert.equal(status.status, "ERROR");
    assert.equal(status.error.code, "LIBRARY_OPEN_FAILED");
    const raw = JSON.stringify(status);
    assert.equal(raw.includes("test-user-token"), false);
  } finally {
    await close();
    await cleanup();
  }
});

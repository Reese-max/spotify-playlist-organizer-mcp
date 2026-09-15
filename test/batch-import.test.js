import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { importMusicBatch, importStatus, previewImport } from "../src/batch-import.js";
import { openLibrary } from "../src/library.js";

const PL_SOURCE = "PL_IMPORT_SOURCE1";
const PL_SYNC = "PL_IMPORT_SYNC001";
const VID_NEW1 = "V_NEW000001";
const VID_NEW2 = "V_NEW000002";
const VID_DUP = "V_DUP000001";
const VID_GONE = "DELETEDVID0";

class StubYouTube {
  constructor({ abortAfter = null, controller = null } = {}) {
    this.playlists = new Map();
    this.items = new Map();
    this.videos = new Map();
    this.searches = new Map();
    this.addCalls = [];
    this.getVideoCalls = 0;
    this.abortAfter = abortAfter;
    this.controller = controller;
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
    this.getVideoCalls += 1;
    if (this.abortAfter && this.getVideoCalls > this.abortAfter) {
      this.controller?.abort();
    }
    const video = this.videos.get(id);
    if (!video) {
      const error = new Error("not found");
      error.code = "NOT_FOUND";
      error.status = 404;
      throw error;
    }
    return video;
  }
  async searchVideos(query) {
    return { videos: this.searches.get(query) ?? [] };
  }
  async addVideoToPlaylist(playlistId, videoId) {
    this.addCalls.push(`${playlistId}:${videoId}`);
    const list = this.items.get(playlistId) ?? [];
    if (!list.some((item) => item.id === videoId)) {
      list.push({ id: videoId, name: this.videos.get(videoId)?.name ?? videoId });
    }
    this.items.set(playlistId, list);
    return { added: true };
  }
}

async function tempLibrary() {
  const directory = await mkdtemp(path.join(tmpdir(), "music-library-import-"));
  return { directory, filePath: path.join(directory, "library.sqlite") };
}

async function fixture(t) {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  const youtube = new StubYouTube();
  t.after(async () => {
    library.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { library, youtube };
}

function seedRemote(youtube) {
  youtube.playlists.set(PL_SOURCE, { id: PL_SOURCE, name: "Source PL" });
  youtube.items.set(PL_SOURCE, [
    { id: VID_NEW1, name: "New One" },
    { id: VID_NEW2, name: "New Two" },
    { id: VID_GONE, name: "Deleted video" },
  ]);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "New One", channel: "Chan" });
  youtube.videos.set(VID_NEW2, { id: VID_NEW2, name: "New Two", channel: "Chan" });
}

test("preview_import reports total/new/duplicate/unresolved/unavailable without writing", async (t) => {
  const { library, youtube } = await fixture(t);
  seedRemote(youtube);
  // An already-imported video is an exact duplicate at preview time.
  library.upsertTrack({
    title: "Already Here",
    source: { provider: "youtube", sourceId: VID_DUP },
  });
  youtube.videos.set(VID_DUP, { id: VID_DUP, name: "Already Here" });

  const preview = await previewImport(
    { library, youtube },
    {
      items: [
        `https://www.youtube.com/watch?v=${VID_NEW1}`,
        VID_DUP,
        "a song nobody can find",
      ],
      playlist: PL_SOURCE,
    },
  );

  assert.equal(preview.mode, "preview");
  assert.ok(preview.batchId);
  assert.equal(preview.counts.total, 6); // 3 items + 3 playlist entries
  assert.equal(preview.counts.new, 2); // VID_NEW1 + VID_NEW2
  assert.equal(preview.counts.exactDuplicate, 2); // VID_DUP + NEW1 again inside the batch
  assert.equal(preview.counts.unresolved, 1);
  assert.equal(preview.counts.unavailable, 1);
  // Preview performs no writes of any kind.
  assert.equal(library.trackCount(), 1);
  assert.equal(youtube.addCalls.length, 0);
});

test("import apply imports only resolved items, reports per-item results, survives partial failure", async (t) => {
  const { library, youtube } = await fixture(t);
  seedRemote(youtube);

  const applied = await importMusicBatch(
    { library, youtube },
    { playlist: PL_SOURCE },
  );
  assert.equal(applied.mode, "apply");
  assert.equal(applied.action, "imported");
  assert.equal(library.trackCount(), 2);
  const statuses = applied.results.map((entry) => entry.status).sort();
  assert.deepEqual(statuses, ["imported", "imported", "unavailable"]);
  const gone = applied.results.find((entry) => entry.status === "unavailable");
  assert.equal(gone.videoId, VID_GONE);
});

test("re-running the same import is idempotent — every item reports exact_duplicate", async (t) => {
  const { library, youtube } = await fixture(t);
  seedRemote(youtube);
  await importMusicBatch({ library, youtube }, { playlist: PL_SOURCE });
  assert.equal(library.trackCount(), 2);

  const again = await importMusicBatch({ library, youtube }, { playlist: PL_SOURCE });
  assert.equal(library.trackCount(), 2);
  for (const entry of again.results) {
    assert.notEqual(entry.status, "imported");
  }
  assert.equal(again.results.filter((entry) => entry.status === "exact_duplicate").length, 2);
});

test("canonical duplicates merge into the existing track instead of creating a second one", async (t) => {
  const { library, youtube } = await fixture(t);
  library.upsertTrack({
    title: "Same Song",
    artist: "Same Artist",
    source: { provider: "youtube", sourceId: "V_OTHER0001" },
  });
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Same Song", channel: "Same Artist" });

  const applied = await importMusicBatch(
    { library, youtube },
    { items: [`https://youtu.be/${VID_NEW1}`] },
  );
  assert.equal(library.trackCount(), 1);
  assert.equal(applied.results[0].status, "canonical_duplicate");
  assert.equal(library.listTrackSources(applied.results[0].trackId).length, 2);
});

test("text lines resolve through search; unresolvable input is reported, not dropped", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.searches.set("lofi beats", [{ id: VID_NEW1, name: "Lofi Beats" }]);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Lofi Beats" });

  const preview = await previewImport(
    { library, youtube },
    { items: ["lofi beats", "   ", "not a real song xyzzy"] },
  );
  const byInput = new Map(preview.items.map((item) => [item.input, item]));
  assert.equal(byInput.get("lofi beats").status, "new");
  assert.equal(byInput.get("lofi beats").resolvedBy, "search");
  assert.equal(byInput.get("not a real song xyzzy").status, "unresolved");

  const applied = await importMusicBatch(
    { library, youtube },
    { items: ["lofi beats", "not a real song xyzzy"] },
  );
  assert.equal(library.trackCount(), 1);
  assert.equal(applied.results.length, 2);
});

test("caller cancellation produces a partial receipt that can resume", async (t) => {
  const controller = new AbortController();
  const youtube = new StubYouTube({ abortAfter: 1, controller });
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  t.after(async () => {
    library.close();
    await rm(directory, { recursive: true, force: true });
  });
  seedRemote(youtube);

  const partial = await importMusicBatch(
    { library, youtube },
    { playlist: PL_SOURCE },
    { signal: controller.signal },
  );
  assert.equal(partial.action, "cancelled");
  assert.ok(partial.results.length < partial.counts.total);
  assert.ok(partial.remaining > 0);
  const batchId = partial.batchId;

  // Resume with a fresh controller — remaining items complete.
  const resumed = await importMusicBatch(
    { library, youtube },
    { batchId, resume: true },
  );
  assert.equal(resumed.action, "imported");
  assert.equal(library.trackCount(), 2);

  const status = importStatus(library, { batchId });
  assert.equal(status.counts.total, 3);
  assert.equal(status.done, 3);
});

test("apply by batchId only processes what preview resolved; YouTube sync is opt-in", async (t) => {
  const { library, youtube } = await fixture(t);
  seedRemote(youtube);
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);

  const preview = await previewImport(
    { library, youtube },
    { items: [`https://youtu.be/${VID_NEW1}`], syncPlaylist: PL_SYNC },
  );
  assert.equal(preview.sync.playlistId, PL_SYNC);
  assert.equal(preview.sync.additions, 1);

  // Default: local library only — provider is untouched.
  const localOnly = await importMusicBatch(
    { library, youtube },
    { batchId: preview.batchId },
  );
  assert.equal(localOnly.action, "imported");
  assert.equal(youtube.addCalls.length, 0);

  // Explicit opt-in replays the stored plan and pushes to the playlist.
  const synced = await importMusicBatch(
    { library, youtube },
    { batchId: preview.batchId, resume: true, syncPlaylist: PL_SYNC },
  );
  assert.ok(youtube.addCalls.includes(`${PL_SYNC}:${VID_NEW1}`));
});

test("import_status summarizes a stored batch", async (t) => {
  const { library, youtube } = await fixture(t);
  seedRemote(youtube);
  const preview = await previewImport({ library, youtube }, { playlist: PL_SOURCE });
  const status = importStatus(library, { batchId: preview.batchId });
  assert.equal(status.counts.total, 3);
  assert.equal(status.done, 0);
  assert.equal(status.pending, 3);
  await importMusicBatch({ library, youtube }, { batchId: preview.batchId });
  const after = importStatus(library, { batchId: preview.batchId });
  assert.equal(after.done, 3);
});

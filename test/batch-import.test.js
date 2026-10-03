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

test("a confirmed private video is unavailable before any import write", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Private Song", status: "private" });
  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1] });
  assert.equal(preview.items[0].status, "unavailable");
  const applied = await importMusicBatch({ library, youtube }, { batchId: preview.batchId });
  assert.equal(applied.results[0].status, "unavailable");
  assert.equal(library.trackCount(), 0);
});

test("transient exact-ID preview remains pending until apply can verify it", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Recovered Preview" });
  const originalGetVideo = youtube.getVideo.bind(youtube);
  youtube.getVideo = async () => {
    throw Object.assign(new Error("preview timed out"), { code: "TIMEOUT" });
  };

  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1] });
  assert.equal(preview.items[0].status, "retryable");
  assert.equal(preview.counts.retryable, 1);
  assert.equal(importStatus(library, { batchId: preview.batchId }).pending, 1);
  assert.equal(library.trackCount(), 0);

  youtube.getVideo = originalGetVideo;
  const applied = await importMusicBatch({ library, youtube }, { batchId: preview.batchId });
  assert.equal(applied.results[0].status, "imported");
  assert.equal(applied.remaining, 0);
  assert.equal(library.getTrackBySource("youtube", VID_NEW1).canonicalTitle, "Recovered Preview");
});

test("duplicate IDs stay pending behind a transient primary and sync only after verified resume", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Recovered Duplicate" });
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);
  const originalGetVideo = youtube.getVideo.bind(youtube);
  youtube.getVideo = async () => {
    throw Object.assign(new Error("provider temporarily unavailable"), { status: 503 });
  };

  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1, VID_NEW1] });
  assert.deepEqual(preview.items.map((item) => item.status), ["retryable", "retryable"]);
  assert.equal(preview.counts.retryable, 2);
  const partial = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SYNC },
  );
  assert.deepEqual(partial.results.map((item) => item.status), ["retryable", "retryable"]);
  assert.equal(partial.remaining, 2);
  assert.equal(importStatus(library, { batchId: preview.batchId }).pending, 2);
  assert.equal(library.trackCount(), 0);
  assert.deepEqual(youtube.addCalls, []);

  youtube.getVideo = originalGetVideo;
  const resumed = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, resume: true, syncPlaylist: PL_SYNC },
  );
  assert.deepEqual(resumed.results.map((item) => item.status), ["imported", "exact_duplicate"]);
  assert.equal(resumed.remaining, 0);
  assert.equal(library.trackCount(), 1);
  assert.deepEqual(youtube.addCalls, [`${PL_SYNC}:${VID_NEW1}`]);
});

for (const [outcome, video] of [
  ["missing", null],
  ["private", { id: VID_NEW1, name: "Private", status: "private" }],
]) {
  test(`duplicate IDs become unavailable when a retryable primary is confirmed ${outcome}`, async (t) => {
    const { library, youtube } = await fixture(t);
    youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Initially Present" });
    youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
    youtube.items.set(PL_SYNC, []);
    const originalGetVideo = youtube.getVideo.bind(youtube);
    youtube.getVideo = async () => {
      throw Object.assign(new Error("preview temporarily unavailable"), { status: 503 });
    };
    const preview = await previewImport({ library, youtube }, { items: [VID_NEW1, VID_NEW1] });
    youtube.getVideo = originalGetVideo;
    if (video) youtube.videos.set(VID_NEW1, video);
    else youtube.videos.delete(VID_NEW1);

    const applied = await importMusicBatch(
      { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SYNC },
    );
    assert.deepEqual(applied.results.map((item) => item.status), ["unavailable", "unavailable"]);
    assert.equal(applied.remaining, 0);
    assert.equal(library.trackCount(), 0);
    assert.deepEqual(youtube.addCalls, []);
  });
}

test("an existing exact duplicate is rechecked before playlist sync", async (t) => {
  const { library, youtube } = await fixture(t);
  library.upsertTrack({
    title: "Existing Song",
    source: { provider: "youtube", sourceId: VID_NEW1 },
  });
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Existing Song" });
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);
  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1, VID_NEW1] });
  assert.deepEqual(preview.items.map((item) => item.status), ["exact_duplicate", "exact_duplicate"]);

  youtube.videos.get(VID_NEW1).status = "private";
  const applied = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SYNC },
  );
  assert.deepEqual(applied.results.map((item) => item.status), ["unavailable", "unavailable"]);
  assert.deepEqual(youtube.addCalls, []);
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
  assert.equal(synced.action, "imported");
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

for (const [failureName, failure] of [
  ["timeout", { code: "TIMEOUT" }],
  ["rate limit", { code: "HTTP_429", status: 429 }],
  ["server error", { code: "HTTP_5XX", status: 503 }],
  ["network error", { code: "NETWORK_ERROR" }],
]) {
  test(`${failureName} during apply verification remains pending and succeeds on resume`, async (t) => {
    const { library, youtube } = await fixture(t);
    youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Recoverable Song" });
    const preview = await previewImport({ library, youtube }, { items: [VID_NEW1] });
    const originalGetVideo = youtube.getVideo.bind(youtube);
    youtube.getVideo = async () => {
      throw Object.assign(new Error("temporary provider failure"), failure);
    };

    const partial = await importMusicBatch({ library, youtube }, { batchId: preview.batchId });
    assert.equal(partial.action, "partial_failure");
    assert.equal(partial.results[0].status, "retryable");
    assert.equal(partial.remaining, 1);
    assert.equal(importStatus(library, { batchId: preview.batchId }).pending, 1);
    assert.equal(library.trackCount(), 0);

    youtube.getVideo = originalGetVideo;
    const resumed = await importMusicBatch(
      { library, youtube }, { batchId: preview.batchId, resume: true },
    );
    assert.equal(resumed.action, "imported");
    assert.equal(resumed.results[0].status, "imported");
    assert.equal(library.trackCount(), 1);
  });
}

test("caller cancellation during apply verification leaves the item retryable", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Cancelled Song" });
  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1] });
  const controller = new AbortController();
  const originalGetVideo = youtube.getVideo.bind(youtube);
  youtube.getVideo = async () => {
    controller.abort();
    throw Object.assign(new Error("caller cancelled"), { code: "CALLER_CANCELLED" });
  };

  const partial = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId }, { signal: controller.signal },
  );
  assert.equal(partial.action, "cancelled");
  assert.equal(partial.results[0].status, "retryable");
  assert.equal(partial.remaining, 1);
  assert.equal(importStatus(library, { batchId: preview.batchId }).pending, 1);
  assert.equal(library.trackCount(), 0);

  youtube.getVideo = originalGetVideo;
  const resumed = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, resume: true },
  );
  assert.equal(resumed.results[0].status, "imported");
  assert.equal(library.trackCount(), 1);
});

test("a failed requested playlist add makes the batch partial and names reconciliation", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Sync Me" });
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);
  const preview = await previewImport(
    { library, youtube }, { items: [VID_NEW1], syncPlaylist: PL_SYNC },
  );
  youtube.addVideoToPlaylist = async () => {
    throw Object.assign(new Error("playlist write rejected"), { status: 403 });
  };

  const result = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SYNC },
  );
  assert.equal(result.action, "partial_failure");
  assert.equal(result.results[0].status, "imported");
  assert.equal(result.sync.results[0].status, "failed");
  assert.match(result.nextStep, /playlist.*membership|membership.*playlist/i);
});

test("an ambiguous playlist add reports UNKNOWN_AFTER_WRITE with exact IDs and reconciles safely", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Uncertain Song" });
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);
  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1] });
  const originalAdd = youtube.addVideoToPlaylist.bind(youtube);
  youtube.addVideoToPlaylist = async (playlistId, videoId) => {
    await originalAdd(playlistId, videoId); // write landed; response was lost
    throw Object.assign(new Error("connection dropped after write"), { code: "TIMEOUT" });
  };

  const unknown = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SYNC },
  );
  assert.equal(unknown.action, "UNKNOWN_AFTER_WRITE");
  assert.equal(unknown.results[0].status, "imported");
  assert.equal(unknown.sync.failed, 0);
  assert.equal(unknown.sync.unknown, 1);
  assert.deepEqual(
    [unknown.sync.results[0].playlistId, unknown.sync.results[0].videoId,
      unknown.sync.results[0].status, unknown.sync.results[0].writeState],
    [PL_SYNC, VID_NEW1, "unknown_after_write", "UNKNOWN_AFTER_WRITE"],
  );
  assert.match(unknown.nextStep, new RegExp(PL_SYNC));
  assert.match(unknown.nextStep, new RegExp(VID_NEW1));

  const retried = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SYNC, resume: true },
  );
  assert.equal(retried.action, "imported");
  assert.equal(youtube.addCalls.length, 1);
  assert.equal(youtube.items.get(PL_SYNC).length, 1);
});

test("mixed requested sync successes and explicit failures stay partial", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Added Song" });
  youtube.videos.set(VID_NEW2, { id: VID_NEW2, name: "Rejected Song" });
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);
  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1, VID_NEW2] });
  const originalAdd = youtube.addVideoToPlaylist.bind(youtube);
  youtube.addVideoToPlaylist = async (playlistId, videoId) => {
    if (videoId === VID_NEW2) throw Object.assign(new Error("forbidden"), { status: 403 });
    return originalAdd(playlistId, videoId);
  };

  const partial = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SYNC },
  );
  assert.equal(partial.action, "partial_failure");
  assert.equal(partial.results.filter((entry) => entry.status === "imported").length, 2);
  assert.equal(partial.sync.failed, 1);
  assert.equal(partial.sync.unknown, 0);
  assert.deepEqual(partial.sync.results.map((entry) => [entry.videoId, entry.status]), [
    [VID_NEW1, "added"], [VID_NEW2, "failed"],
  ]);
  assert.equal(library.trackCount(), 2);
  assert.match(partial.nextStep, /verify playlist membership/i);
});

test("a status-less preflight rejection is a definite sync failure", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Local Song" });
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);
  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1] });
  youtube.addVideoToPlaylist = async () => {
    throw Object.assign(new Error("client credentials unavailable"), { code: "AUTH_REQUIRED" });
  };

  const result = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SYNC },
  );
  assert.equal(result.action, "partial_failure");
  assert.equal(result.sync.failed, 1);
  assert.equal(result.sync.unknown, 0);
  assert.equal(result.sync.results[0].status, "failed");
});

test("import_status pages stored item detail in bounded windows", async (t) => {
  const { library, youtube } = await fixture(t);
  const PL_BIG = "PL_IMPORT_BIG001";
  const entries = [];
  for (let i = 0; i < 60; i += 1) {
    entries.push({ id: `BIGITEM${String(i).padStart(4, "0")}`, name: `Big Song ${i}` });
  }
  youtube.playlists.set(PL_BIG, { id: PL_BIG, name: "Big Source" });
  youtube.items.set(PL_BIG, entries);

  const preview = await previewImport({ library, youtube }, { playlist: PL_BIG });
  assert.equal(preview.counts.total, 60);
  assert.equal(preview.truncated, false); // under the per-call detail cap

  const first = importStatus(library, { batchId: preview.batchId, limit: 25 });
  assert.equal(first.itemsTotal, 60);
  assert.equal(first.items.length, 25);
  assert.equal(first.itemsTruncated, true);
  assert.equal(first.nextOffset, 25);
  assert.equal(first.items[0].input, `${PL_BIG}:${entries[0].id}`);

  const last = importStatus(library, { batchId: preview.batchId, offset: 50, limit: 25 });
  assert.equal(last.items.length, 10);
  assert.equal(last.itemsTruncated, false);
  assert.equal(last.nextOffset, null);
  assert.equal(last.items[0].input, `${PL_BIG}:${entries[50].id}`);

  // An offset past the end is an empty final page, not an error.
  const pastEnd = importStatus(library, { batchId: preview.batchId, offset: 500 });
  assert.equal(pastEnd.items.length, 0);
  assert.equal(pastEnd.itemsTruncated, false);
  assert.equal(pastEnd.nextOffset, null);

  // The default call returns the first bounded page, preserving plan order.
  const head = importStatus(library, { batchId: preview.batchId });
  assert.equal(head.items.length, 60);
  assert.equal(head.itemsTruncated, false);
});

test("unresolved and retryable items carry their provider error into the stored receipt", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Flaky Song" });
  youtube.searchVideos = async () => {
    throw Object.assign(new Error("quota exhausted"), { code: "HTTP_429", status: 429 });
  };
  youtube.getVideo = async () => {
    throw Object.assign(new Error("provider timed out"), { code: "TIMEOUT" });
  };

  const preview = await previewImport(
    { library, youtube },
    { items: [VID_NEW1, "unresolvable song title"] },
  );
  const byInput = new Map(preview.items.map((item) => [item.input, item]));
  assert.equal(byInput.get(VID_NEW1).status, "retryable");
  assert.equal(byInput.get(VID_NEW1).error.code, "TIMEOUT");
  assert.equal(byInput.get("unresolvable song title").status, "unresolved");
  assert.equal(byInput.get("unresolvable song title").error.status, 429);

  // The same detail is readable after the call ends — a timed-out apply
  // leaves the caller with nothing but the stored plan to reconcile from.
  const status = importStatus(library, { batchId: preview.batchId });
  const stored = new Map(status.items.map((item) => [item.input, item]));
  assert.equal(stored.get(VID_NEW1).error.code, "TIMEOUT");
  assert.equal(stored.get("unresolvable song title").error.status, 429);
});

test("an oversized apply receipt is bounded; import_status pages the full record", async (t) => {
  const { library, youtube } = await fixture(t);
  const PL_HUGE = "PL_IMPORT_HUGE01";
  const entries = [];
  for (let i = 0; i < 510; i += 1) {
    entries.push({ id: `HUGE_${String(i).padStart(5, "0")}`, name: "Deleted video" });
  }
  youtube.playlists.set(PL_HUGE, { id: PL_HUGE, name: "Huge Source" });
  youtube.items.set(PL_HUGE, entries);

  const applied = await importMusicBatch({ library, youtube }, { playlist: PL_HUGE });
  assert.equal(applied.counts.total, 510);
  assert.equal(applied.results.length, 500);
  assert.equal(applied.resultsTruncated, true);
  assert.equal(applied.resultsTotal, 510);
  assert.match(applied.nextStep, /import_status/);

  const tail = importStatus(library, { batchId: applied.batchId, offset: 500, limit: 25 });
  assert.equal(tail.items.length, 10);
  assert.equal(tail.items[0].result, "unavailable");
});

test("per-item sync outcomes persist on the plan and page through import_status", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Synced Song" });
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);

  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1] });
  const applied = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SYNC },
  );
  assert.equal(applied.sync.results[0].status, "added");

  // A later caller reconciling a lost response sees the per-item outcome.
  const status = importStatus(library, { batchId: preview.batchId });
  assert.equal(status.items[0].result, "imported");
  assert.equal(status.items[0].syncResult, "added");
  assert.equal(status.items[0].syncPlaylistId, PL_SYNC);
});

test("a truncated receipt still surfaces a sync preflight failure via sync.error and import_status", async (t) => {
  const { library, youtube } = await fixture(t);
  const PL_HUGE = "PL_IMPORT_HUGE01";
  const entries = [];
  for (let i = 0; i < 510; i += 1) {
    entries.push({ id: `HUGE_${String(i).padStart(5, "0")}`, name: "Deleted video" });
  }
  youtube.playlists.set(PL_HUGE, { id: PL_HUGE, name: "Huge Source" });
  youtube.items.set(PL_HUGE, entries);
  const originalGetItems = youtube.getPlaylistItems.bind(youtube);
  youtube.getPlaylistItems = async (id) => {
    if (id === PL_SYNC) {
      throw Object.assign(new Error("sync target listing timed out"), { code: "TIMEOUT", status: 503 });
    }
    return originalGetItems(id);
  };

  const applied = await importMusicBatch(
    { library, youtube }, { playlist: PL_HUGE, syncPlaylist: PL_SYNC },
  );
  assert.equal(applied.action, "partial_failure");
  assert.equal(applied.resultsTruncated, true);
  assert.equal(applied.results.length, 500);
  // The preflight failure detail survives receipt truncation.
  assert.equal(applied.sync.error.status, 503);
  assert.match(applied.nextStep, /could not be listed|no additions were attempted/i);

  const status = importStatus(library, { batchId: applied.batchId });
  assert.equal(status.syncError.status, 503);
});

test("sync receipts are bounded; per-item outcomes and duplicate mirrors page through import_status", async (t) => {
  const { library, youtube } = await fixture(t);
  const PL_BIGSYNC = "PL_BIG_SYNC_0001";
  const entries = [];
  for (let i = 0; i < 501; i += 1) {
    const id = `SYNCME_${String(i).padStart(4, "0")}`;
    entries.push({ id, name: `Sync Song ${i}` });
    youtube.videos.set(id, { id, name: `Sync Song ${i}`, channel: "Chan" });
  }
  youtube.playlists.set(PL_BIGSYNC, { id: PL_BIGSYNC, name: "Big Sync Source" });
  youtube.items.set(PL_BIGSYNC, entries);
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);

  const applied = await importMusicBatch(
    { library, youtube }, { playlist: PL_BIGSYNC, syncPlaylist: PL_SYNC },
  );
  assert.equal(applied.sync.results.length, 500);
  assert.equal(applied.sync.resultsTruncated, true);
  assert.equal(applied.sync.resultsTotal, 501);
  assert.equal(applied.sync.failed, 0);

  const tail = importStatus(library, { batchId: applied.batchId, offset: 500, limit: 25 });
  assert.equal(tail.items.length, 1);
  assert.equal(tail.items[0].result, "imported");
  assert.equal(tail.items[0].syncResult, "added");
  assert.equal(tail.items[0].syncPlaylistId, PL_SYNC);
});

test("in-batch duplicate rows mirror the primary item's sync outcome", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Dup Sync Song" });
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);

  const applied = await importMusicBatch(
    { library, youtube }, { items: [VID_NEW1, VID_NEW1], syncPlaylist: PL_SYNC },
  );
  assert.deepEqual(applied.results.map((entry) => entry.status), ["imported", "exact_duplicate"]);
  assert.equal(youtube.addCalls.length, 1); // one playlist add per videoId

  const status = importStatus(library, { batchId: applied.batchId });
  assert.deepEqual(
    status.items.map((item) => item.syncResult),
    ["added", "added"],
  );
});

test("credential-shaped provider error text is redacted before it is stored or reported", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Flaky Song" });
  youtube.searchVideos = async () => {
    throw Object.assign(
      new Error("quota rejected for Bearer ya29.a0AfH6SMBnotarealsecret"),
      { code: "HTTP_401", status: 401 },
    );
  };
  youtube.getVideo = async () => {
    throw Object.assign(
      new Error("bad request with key AIzaSyD0123456789abcdefghijklmnop"),
      { code: "HTTP_400", status: 400 },
    );
  };

  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1, "some song"] });
  const byInput = new Map(preview.items.map((item) => [item.input, item]));
  // VID_NEW1 resolves by exact id (getVideo), "some song" falls back to search.
  assert.equal(byInput.get(VID_NEW1).status, "retryable");
  assert.match(byInput.get(VID_NEW1).error.message, /\[REDACTED\]/);
  assert.doesNotMatch(byInput.get(VID_NEW1).error.message, /AIzaSyD/);
  assert.equal(byInput.get("some song").status, "unresolved");
  assert.match(byInput.get("some song").error.message, /\[REDACTED\]/);
  assert.doesNotMatch(byInput.get("some song").error.message, /ya29\./);
  // Redaction must not destroy the triage fields.
  assert.equal(byInput.get(VID_NEW1).error.code, "HTTP_400");
  assert.equal(byInput.get(VID_NEW1).error.status, 400);
  assert.equal(byInput.get("some song").error.code, "HTTP_401");

  // The persisted plan is a Database row — nothing credential-shaped may land
  // in it, or in the reconciliation page read back out of it.
  const stored = library.getSyncState(`import.${preview.batchId}`);
  assert.doesNotMatch(stored, /ya29\./);
  assert.doesNotMatch(stored, /AIzaSyD/);
  assert.match(stored, /\[REDACTED\]/);

  const storedStatus = importStatus(library, { batchId: preview.batchId });
  assert.doesNotMatch(JSON.stringify(storedStatus.items), /ya29\.|AIzaSyD/);
});

test("a stale sync preflight error does not resurface after a local-only re-apply", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Preflight Song" });
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);
  const originalGetItems = youtube.getPlaylistItems.bind(youtube);
  let listingFails = true;
  youtube.getPlaylistItems = async (id) => {
    if (id === PL_SYNC && listingFails) {
      throw Object.assign(new Error("sync target listing timed out"), { code: "TIMEOUT", status: 503 });
    }
    return originalGetItems(id);
  };

  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1] });
  const first = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SYNC },
  );
  assert.equal(first.action, "partial_failure");
  assert.equal(importStatus(library, { batchId: preview.batchId }).syncError.status, 503);

  // A later apply that does not opt into sync performs no sync attempt, so the
  // previous attempt's preflight failure must not be reported as this run's.
  listingFails = false;
  const second = await importMusicBatch({ library, youtube }, { batchId: preview.batchId });
  assert.equal(second.sync, undefined);
  const status = importStatus(library, { batchId: preview.batchId });
  assert.equal(status.syncError, undefined);
});

test("re-syncing to a second playlist refreshes every duplicate row's sync target", async (t) => {
  const { library, youtube } = await fixture(t);
  const PL_SECOND = "PL_IMPORT_SECOND";
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Resync Song" });
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.playlists.set(PL_SECOND, { id: PL_SECOND, name: "Second Target" });
  youtube.items.set(PL_SYNC, []);
  youtube.items.set(PL_SECOND, []);

  const preview = await previewImport({ library, youtube }, { items: [VID_NEW1, VID_NEW1] });
  const first = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SYNC },
  );
  assert.deepEqual(
    first.sync.results.map((entry) => entry.playlistId),
    [PL_SYNC],
  );

  // Same batch, a different explicit sync target: every row for this videoId
  // must report the current target, never a mix of the two.
  const second = await importMusicBatch(
    { library, youtube }, { batchId: preview.batchId, syncPlaylist: PL_SECOND },
  );
  assert.equal(second.sync.playlistId, PL_SECOND);

  const status = importStatus(library, { batchId: preview.batchId });
  assert.deepEqual(
    status.items.map((item) => item.syncResult),
    ["added", "added"],
  );
  assert.deepEqual(
    status.items.map((item) => item.syncPlaylistId),
    [PL_SECOND, PL_SECOND],
  );
  // The first target really was written before the re-sync.
  assert.deepEqual(youtube.addCalls, [`${PL_SYNC}:${VID_NEW1}`, `${PL_SECOND}:${VID_NEW1}`]);
});

test("an UNKNOWN_AFTER_WRITE receipt names a bounded set of video IDs", async (t) => {
  const { library, youtube } = await fixture(t);
  const PL_MANY = "PL_IMPORT_MANY01";
  const entries = [];
  for (let i = 0; i < 520; i += 1) {
    const id = `UNK_${String(i).padStart(4, "0")}`;
    entries.push({ id, name: `Unknown Song ${i}` });
    youtube.videos.set(id, { id, name: `Unknown Song ${i}`, channel: "Chan" });
  }
  youtube.playlists.set(PL_MANY, { id: PL_MANY, name: "Many Source" });
  youtube.items.set(PL_MANY, entries);
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);
  youtube.addVideoToPlaylist = async () => {
    throw Object.assign(new Error("add timed out"), { code: "TIMEOUT", status: 503 });
  };

  const applied = await importMusicBatch(
    { library, youtube }, { playlist: PL_MANY, syncPlaylist: PL_SYNC },
  );
  assert.equal(applied.action, "UNKNOWN_AFTER_WRITE");
  assert.equal(applied.sync.results.length, 500);
  assert.equal(applied.sync.resultsTruncated, true);
  // The prose receipt must stay bounded too — it is part of the same response.
  const named = applied.nextStep.match(/UNK_\d{4}/g) ?? [];
  assert.ok(named.length <= 500, `nextStep named ${named.length} video IDs`);
  assert.match(applied.nextStep, /and 20 more|import_status/);
  assert.ok(applied.nextStep.length < 12000, `nextStep is ${applied.nextStep.length} chars`);
});

test("a cancelled apply that opted into sync keeps the previous preflight failure", async (t) => {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  t.after(async () => {
    library.close();
    await rm(directory, { recursive: true, force: true });
  });

  const controller = new AbortController();
  const youtube = new StubYouTube({ abortAfter: 1, controller });
  youtube.playlists.set(PL_SYNC, { id: PL_SYNC, name: "Sync Target" });
  youtube.items.set(PL_SYNC, []);
  // Three pending items: the abort fires during the second read-back, so the
  // third is what trips the loop's cancellation check.
  const pending = ["V_PEND00001", "V_PEND00002", "V_PEND00003"].map((videoId) => ({
    input: videoId,
    videoId,
    title: "Pending Song",
    status: "new",
  }));
  for (const item of pending) {
    youtube.videos.set(item.videoId, { id: item.videoId, name: item.title, channel: "Chan" });
  }
  library.setSyncState("import.SEEDEDBATCH", {
    batchId: "SEEDEDBATCH",
    createdAt: "2026-01-01T00:00:00.000Z",
    playlistId: null,
    syncPlaylistId: null,
    syncError: { code: "TIMEOUT", message: "sync target listing timed out", status: 503 },
    items: pending,
  });

  const applied = await importMusicBatch(
    { library, youtube },
    { batchId: "SEEDEDBATCH", syncPlaylist: PL_SYNC },
    { signal: controller.signal },
  );
  assert.equal(applied.action, "cancelled");
  // No sync was attempted, so the last known sync failure is still the truth.
  assert.deepEqual(applied.sync.results, []);
  assert.equal(importStatus(library, { batchId: "SEEDEDBATCH" }).syncError.status, 503);
});

test("OAuth credential shapes echoed by a provider are redacted from stored errors", async (t) => {
  const { library, youtube } = await fixture(t);
  youtube.videos.set(VID_NEW1, { id: VID_NEW1, name: "Echoing Song" });
  youtube.getVideo = async () => {
    throw Object.assign(
      new Error("request rejected: access_token=ya29.notrealbutsecretvalue expired"),
      { code: "HTTP_403", status: 403 },
    );
  };

  const applied = await importMusicBatch({ library, youtube }, { items: [VID_NEW1] });
  assert.equal(applied.results[0].status, "retryable");
  assert.match(applied.results[0].error.message, /\[REDACTED\]/);
  assert.doesNotMatch(applied.results[0].error.message, /access_token=/);
  assert.doesNotMatch(
    library.getSyncState(`import.${applied.batchId}`),
    /access_token=/,
  );
});

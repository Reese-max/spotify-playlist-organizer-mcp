import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openLibrary } from "../src/library.js";
import { reconcileTrack, syncStatus, syncYoutube } from "../src/library-sync.js";

function youtubeSource(id) {
  return { provider: "youtube", sourceId: id, url: "https://www.youtube.com/watch?v=" + id };
}

function stubYouTube(overrides = {}) {
  const calls = [];
  const playlists = new Map();
  const items = new Map(); // playlistId -> [{playlistItemId, videoId, name, status}]
  return {
    env: {},
    calls,
    playlists,
    items,
    async getPlaylist(id) {
      calls.push(["getPlaylist", id]);
      const found = playlists.get(id);
      if (!found) throw Object.assign(new Error("YouTube playlist was not found: " + id), { status: 404 });
      return found;
    },
    async getPlaylistItems(id) {
      calls.push(["getPlaylistItems", id]);
      return (items.get(id) ?? []).map((item, index) => ({
        position: index + 1,
        id: item.videoId,
        name: item.name ?? "video " + item.videoId,
        status: item.status ?? "public",
        url: "https://www.youtube.com/watch?v=" + item.videoId,
      }));
    },
    async getVideo(id) {
      calls.push(["getVideo", id]);
      if (id === "DELETEDVID0") {
        throw Object.assign(new Error("YouTube video was not found: " + id), { status: 404 });
      }
      return { id, name: "video " + id, url: "https://www.youtube.com/watch?v=" + id };
    },
    async listPlaylists() {
      calls.push(["listPlaylists"]);
      return { total: playlists.size, playlists: [...playlists.values()] };
    },
    async addVideoToPlaylist(playlistId, videoId) {
      calls.push(["addVideoToPlaylist", playlistId, videoId]);
      const current = items.get(playlistId) ?? [];
      current.push({ playlistItemId: "PI_" + videoId, videoId });
      items.set(playlistId, current);
      return { id: videoId };
    },
    async removeVideoFromPlaylist(playlistId, videoId) {
      calls.push(["removeVideoFromPlaylist", playlistId, videoId]);
      const current = items.get(playlistId) ?? [];
      const index = current.findIndex((item) => item.videoId === videoId);
      if (index === -1) return { removed: false, playlistId, videoId, reason: "not_in_playlist" };
      current.splice(index, 1);
      return { removed: true, playlistId, playlistItemId: "PI_" + videoId, videoId };
    },
    ...overrides,
  };
}

async function tempLibrary() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "library-sync-"));
  return {
    directory,
    library: openLibrary(path.join(directory, "library.sqlite")),
  };
}

async function seedTrack(library, { title, videoId, playlistId, playlistName }) {
  const saved = library.upsertTrack({
    title,
    source: youtubeSource(videoId),
    ...(playlistId
      ? { playlist: { provider: "youtube", playlistId, name: playlistName ?? null } }
      : {}),
  });
  return saved.track;
}

test("sync_status reports in_sync/local_only/youtube_only/unavailable/conflict/unknown_after_write read-only", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const inSync = await seedTrack(library, { title: "In Sync", videoId: "V_INSYNC001", playlistId: "PL_MAIN", playlistName: "Old Name" });
    const localOnly = await seedTrack(library, { title: "Local Only", videoId: "V_LOCAL0001", playlistId: "PL_MAIN", playlistName: "Old Name" });
    const conflict = await seedTrack(library, { title: "Conflict", videoId: "V_CONFL0001", playlistId: "PL_MAIN", playlistName: "Old Name" });
    library.setNeedsReview(conflict.id, true);
    const unknown = await seedTrack(library, { title: "Unknown", videoId: "V_UNKNO0001", playlistId: "PL_MAIN", playlistName: "Old Name" });
    library.setSyncState("sync." + unknown.id, { state: "unknown_after_write", playlistId: "PL_MAIN", videoId: "V_UNKNO0001" });
    const unlinked = await seedTrack(library, { title: "Unlinked", videoId: "V_UNLINK001" });

    youtube.playlists.set("PL_MAIN", { id: "PL_MAIN", name: "New Name" });
    youtube.items.set("PL_MAIN", [
      { playlistItemId: "PI1", videoId: "V_INSYNC001" },
      { playlistItemId: "PI2", videoId: "V_REMOTE001", name: "Remote Only" },
      { playlistItemId: "PI3", videoId: "V_DELTE0001", name: "Deleted video" },
    ]);

    const report = await syncStatus({ library, youtube }, {});
    assert.equal(report.playlists.length, 1);
    assert.equal(report.playlists[0].playlistId, "PL_MAIN");
    assert.equal(report.playlists[0].renamed, true);
    assert.equal(report.playlists[0].remoteName, "New Name");

    const statusOf = (id) => report.tracks.find((entry) => entry.trackId === id)?.status;
    assert.equal(statusOf(inSync.id), "in_sync");
    assert.equal(statusOf(localOnly.id), "local_only");
    assert.equal(statusOf(conflict.id), "conflict");
    assert.equal(statusOf(unknown.id), "unknown_after_write");
    assert.equal(statusOf(unlinked.id), "local_only");

    const remoteOnly = report.videos.find((v) => v.videoId === "V_REMOTE001");
    assert.equal(remoteOnly.status, "youtube_only");
    const deleted = report.videos.find((v) => v.videoId === "V_DELTE0001");
    assert.equal(deleted.status, "unavailable");

    assert.equal(report.summary.in_sync, 1);
    assert.equal(report.summary.local_only, 2);
    assert.equal(report.summary.youtube_only, 1);
    assert.equal(report.summary.unavailable, 1);
    assert.equal(report.summary.conflict, 1);
    assert.equal(report.summary.unknown_after_write, 1);

    // Read-only: no provider writes, no library mutation.
    assert.equal(youtube.calls.filter(([name]) => name === "addVideoToPlaylist" || name === "removeVideoFromPlaylist" || name === "createPlaylist").length, 0);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync_youtube preview returns the delta and performs no provider writes", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    await seedTrack(library, { title: "Missing Remote", videoId: "V_PUSH00001", playlistId: "PL_PUSH", playlistName: "Push" });
    await seedTrack(library, { title: "Present", videoId: "V_THERE0001", playlistId: "PL_PUSH", playlistName: "Push" });
    youtube.playlists.set("PL_PUSH", { id: "PL_PUSH", name: "Push" });
    youtube.items.set("PL_PUSH", [
      { playlistItemId: "PI1", videoId: "V_THERE0001" },
      { playlistItemId: "PI2", videoId: "V_EXTRA0001", name: "Extra" },
    ]);

    const plan = await syncYoutube({ library, youtube }, { mode: "preview", direction: "push" });
    assert.equal(plan.mode, "preview");
    assert.deepEqual(plan.plan.additions.map((a) => a.videoId), ["V_PUSH00001"]);
    assert.equal(plan.plan.removals.length, 0);
    assert.equal(youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length, 0);
    assert.equal(youtube.items.get("PL_PUSH").length, 2);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("sync_youtube push apply adds missing videos, skips existing, and is idempotent", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const missing = await seedTrack(library, { title: "Push Me", videoId: "V_PUSH00002", playlistId: "PL_P2", playlistName: "P2" });
    await seedTrack(library, { title: "Already", videoId: "V_THERE0002", playlistId: "PL_P2", playlistName: "P2" });
    youtube.playlists.set("PL_P2", { id: "PL_P2", name: "P2" });
    youtube.items.set("PL_P2", [{ playlistItemId: "PI1", videoId: "V_THERE0002" }]);

    const first = await syncYoutube({ library, youtube }, { mode: "apply", direction: "push" });
    assert.equal(first.action, "synced");
    assert.deepEqual(
      youtube.calls.filter(([n]) => n === "addVideoToPlaylist"),
      [["addVideoToPlaylist", "PL_P2", "V_PUSH00002"]],
    );
    const marker = JSON.parse(library.getSyncState("sync." + missing.id));
    assert.equal(marker.state, "synced");
    assert.equal(marker.playlistId, "PL_P2");
    assert.equal(marker.videoId, "V_PUSH00002");

    const second = await syncYoutube({ library, youtube }, { mode: "apply", direction: "push" });
    assert.equal(second.plan.additions.length, 0);
    assert.equal(
      youtube.calls.filter(([n]) => n === "addVideoToPlaylist").length,
      1,
    );
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("push never removes remote-only items unless allowRemoval is explicit", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    await seedTrack(library, { title: "Kept", videoId: "V_KEPT00001", playlistId: "PL_RM", playlistName: "Rm" });
    youtube.playlists.set("PL_RM", { id: "PL_RM", name: "Rm" });
    youtube.items.set("PL_RM", [
      { playlistItemId: "PI1", videoId: "V_KEPT00001" },
      { playlistItemId: "PI2", videoId: "V_STRAY0001", name: "Stray" },
    ]);

    const safe = await syncYoutube({ library, youtube }, { mode: "apply", direction: "push" });
    assert.equal(safe.plan.removals.length, 0);
    assert.equal(youtube.items.get("PL_RM").length, 2);
    assert.equal(youtube.calls.filter(([n]) => n === "removeVideoFromPlaylist").length, 0);

    const destructive = await syncYoutube({ library, youtube }, {
      mode: "apply", direction: "push", allowRemoval: true,
    });
    assert.deepEqual(destructive.plan.removals.map((r) => r.videoId), ["V_STRAY0001"]);
    assert.equal(youtube.items.get("PL_RM").length, 1);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("pull apply imports remote-only videos as library tracks linked by exact IDs", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    await seedTrack(library, { title: "Known", videoId: "V_KNOWN0001", playlistId: "PL_PULL", playlistName: "Pull" });
    youtube.playlists.set("PL_PULL", { id: "PL_PULL", name: "Pull" });
    youtube.items.set("PL_PULL", [
      { playlistItemId: "PI1", videoId: "V_KNOWN0001" },
      { playlistItemId: "PI2", videoId: "V_IMPORT001", name: "Imported Song" },
    ]);

    const result = await syncYoutube({ library, youtube }, { mode: "apply", direction: "pull" });
    assert.equal(result.action, "synced");
    assert.deepEqual(result.plan.imports.map((i) => i.videoId), ["V_IMPORT001"]);

    const imported = library.getTrackBySource("youtube", "V_IMPORT001");
    assert.ok(imported);
    assert.equal(imported.canonicalTitle, "Imported Song");
    assert.deepEqual(library.listTrackPlaylists(imported.id), [
      { provider: "youtube", playlistId: "PL_PULL", name: "Pull" },
    ]);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconcile direction updates renamed playlists and marks unavailable sources", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const track = await seedTrack(library, { title: "Gone Video", videoId: "DELETEDVID0", playlistId: "PL_REC", playlistName: "Old" });
    youtube.playlists.set("PL_REC", { id: "PL_REC", name: "Renamed" });
    youtube.items.set("PL_REC", [
      { playlistItemId: "PI1", videoId: "DELETEDVID0", name: "Deleted video" },
    ]);

    const result = await syncYoutube({ library, youtube }, { mode: "apply", direction: "reconcile" });
    assert.equal(result.action, "synced");

    // Playlist name follows the exact ID — no duplicate playlist row.
    const playlists = library.listManagedPlaylists("youtube");
    assert.equal(playlists.length, 1);
    assert.equal(playlists[0].name, "Renamed");

    // Source is marked unavailable; the canonical track is NOT deleted.
    const source = library.source("youtube", "DELETEDVID0");
    assert.equal(source.status, "unavailable");
    assert.ok(library.getTrackById(track.id));
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an ambiguous push failure records unknown_after_write and reconcile_track resolves it by exact-ID read-back", async () => {
  const { directory, library } = await tempLibrary();
  const calls = [];
  const items = new Map();
  const youtube = stubYouTube({
    async addVideoToPlaylist(playlistId, videoId) {
      calls.push(["addVideoToPlaylist", playlistId, videoId]);
      // Simulated lost response: the write actually landed server-side.
      items.set(playlistId, [...(items.get(playlistId) ?? []), { playlistItemId: "PI_" + videoId, videoId }]);
      throw Object.assign(new Error("request timed out"), { code: "TIMEOUT" });
    },
    async getPlaylistItems(id) {
      calls.push(["getPlaylistItems", id]);
      return (items.get(id) ?? []).map((item, index) => ({
        position: index + 1, id: item.videoId, name: "video " + item.videoId, status: "public",
      }));
    },
    async getPlaylist(id) {
      calls.push(["getPlaylist", id]);
      const found = { "PL_LOST": { id: "PL_LOST", name: "Lost" } }[id];
      if (!found) throw Object.assign(new Error("not found"), { status: 404 });
      return found;
    },
    async getVideo(id) {
      calls.push(["getVideo", id]);
      return { id, name: "video " + id };
    },
  });
  youtube.items = items;
  try {
    const track = await seedTrack(library, { title: "Lost Write", videoId: "V_LOST00001", playlistId: "PL_LOST", playlistName: "Lost" });

    const pushed = await syncYoutube({ library, youtube }, { mode: "apply", direction: "push" });
    assert.equal(pushed.action, "reconciliation_required");
    const marker = JSON.parse(library.getSyncState("sync." + track.id));
    assert.equal(marker.state, "unknown_after_write");

    const resolved = await reconcileTrack({ library, youtube }, { trackId: track.id });
    assert.equal(resolved.sync.state, "synced");
    assert.equal(resolved.resolvedFrom, "unknown_after_write");
    assert.equal(JSON.parse(library.getSyncState("sync." + track.id)).state, "synced");

    // No blind retry happened: the add ran exactly once.
    assert.equal(calls.filter(([n]) => n === "addVideoToPlaylist").length, 1);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconcile_track marks a deleted video source unavailable without deleting the track", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const track = await seedTrack(library, { title: "Dead Source", videoId: "DELETEDVID0" });
    const result = await reconcileTrack({ library, youtube }, { trackId: track.id });
    assert.equal(result.sources[0].status, "unavailable");
    assert.ok(library.getTrackById(track.id));
    assert.equal(library.source("youtube", "DELETEDVID0").status, "unavailable");
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { openLibrary } from "../src/library.js";
import {
  deletePlaylist,
  getPlaylistAdmin,
  listPlaylistItemsAdmin,
  removeFromPlaylist,
  renamePlaylistAdmin,
} from "../src/playlist-admin.js";

const PL_ADMIN = "PL_ADMIN_000001";
const VID_1 = "V_ADMIN00001";
const VID_2 = "V_ADMIN00002";

class StubYouTube {
  constructor() {
    this.playlists = new Map();
    this.items = new Map();
    this.itemSeq = 0;
    this.failNextRename = null; // "ambiguous" | "landed"
    this.renameCalls = 0;
    this.deleteCalls = 0;
    this.removeCalls = 0;
    this.itemReadCalls = 0;
    this.failItemReadOnCall = 0; // 1-based call number that throws; 0 = never
  }
  seedPlaylist(id, name, items = []) {
    this.playlists.set(id, { id, name });
    this.items.set(id, items.map((item) => ({ itemId: `item-${++this.itemSeq}`, ...item })));
  }
  async getPlaylist(id) {
    const playlist = this.playlists.get(id);
    if (!playlist) {
      const error = new Error("not found");
      error.code = "NOT_FOUND";
      error.status = 404;
      throw error;
    }
    return { ...playlist, itemCount: (this.items.get(id) ?? []).length };
  }
  async getPlaylistItems(id) {
    this.itemReadCalls += 1;
    if (this.itemReadCalls === this.failItemReadOnCall) {
      const error = new Error("read-back unavailable");
      error.code = "NETWORK_ERROR";
      throw error;
    }
    if (!this.playlists.has(id)) {
      const error = new Error("not found");
      error.code = "NOT_FOUND";
      error.status = 404;
      throw error;
    }
    return (this.items.get(id) ?? []).map((item) => ({
      id: item.id,
      playlistItemId: item.itemId,
      name: item.name,
    }));
  }
  async renamePlaylist(id, name) {
    this.renameCalls += 1;
    if (this.failNextRename === "ambiguous") {
      this.failNextRename = null;
      const error = new Error("socket hangup");
      error.code = "NETWORK_ERROR";
      throw error;
    }
    if (this.failNextRename === "landed") {
      this.failNextRename = null;
      this.playlists.get(id).name = name;
      const error = new Error("timeout");
      error.code = "TIMEOUT";
      throw error;
    }
    this.playlists.get(id).name = name;
    return { id, name };
  }
  async removeVideoFromPlaylist(playlistId, videoId) {
    this.removeCalls += 1;
    const list = this.items.get(playlistId) ?? [];
    const index = list.findIndex((item) => item.id === videoId);
    if (index === -1) return { removed: false, reason: "not_in_playlist" };
    const [item] = list.splice(index, 1);
    this.items.set(playlistId, list);
    return { removed: true, playlistItemId: item.itemId, videoId };
  }
  async deletePlaylist(id) {
    this.deleteCalls += 1;
    this.playlists.delete(id);
    this.items.delete(id);
    return { deleted: true };
  }
}

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "music-library-admin-"));
  const library = openLibrary(path.join(directory, "library.sqlite"));
  const youtube = new StubYouTube();
  youtube.seedPlaylist(PL_ADMIN, "Admin PL", [
    { id: VID_1, name: "Song One" },
    { id: VID_2, name: "Song Two" },
  ]);
  t.after(async () => {
    library.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { library, youtube };
}

test("youtube_get_playlist and list items are read-only with bounded paging", async (t) => {
  const { youtube } = await fixture(t);
  const details = await getPlaylistAdmin({ youtube }, { playlist: PL_ADMIN });
  assert.equal(details.playlist.id, PL_ADMIN);
  assert.equal(details.playlist.name, "Admin PL");
  assert.equal(details.playlist.itemCount, 2);

  const page = await listPlaylistItemsAdmin({ youtube }, { playlist: PL_ADMIN, limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.total, 2);
  assert.equal(page.hasMore, true);
  const second = await listPlaylistItemsAdmin({ youtube }, { playlist: PL_ADMIN, limit: 1, offset: 1 });
  assert.equal(second.items[0].id, VID_2);
  assert.equal(second.hasMore, false);
});

test("rename preview shows old/new names without writing; apply verifies by read-back", async (t) => {
  const { youtube } = await fixture(t);
  const preview = await renamePlaylistAdmin({ youtube }, { playlist: PL_ADMIN, name: "Renamed PL" });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.oldName, "Admin PL");
  assert.equal(preview.newName, "Renamed PL");
  assert.equal(youtube.renameCalls, 0);

  const applied = await renamePlaylistAdmin(
    { youtube },
    { playlist: PL_ADMIN, name: "Renamed PL", mode: "apply" },
  );
  assert.equal(applied.mode, "apply");
  assert.equal(applied.writeState, "RENAMED");
  assert.equal(applied.verified.name, "Renamed PL");
});

test("a lost rename response still reports the truth via exact-ID read-back", async (t) => {
  const { youtube } = await fixture(t);
  youtube.failNextRename = "landed"; // write lands, response lost
  const result = await renamePlaylistAdmin(
    { youtube },
    { playlist: PL_ADMIN, name: "Landed Name", mode: "apply" },
  );
  assert.equal(result.writeState, "RENAMED");
  assert.equal(result.verified.name, "Landed Name");
});

test("a truly uncertain rename reports UNKNOWN_AFTER_WRITE instead of claiming success", async (t) => {
  const { youtube } = await fixture(t);
  youtube.failNextRename = "ambiguous"; // write never lands
  const result = await renamePlaylistAdmin(
    { youtube },
    { playlist: PL_ADMIN, name: "Never", mode: "apply" },
  );
  assert.equal(result.writeState, "UNKNOWN_AFTER_WRITE");
  assert.equal(result.verified.name, "Admin PL");
  assert.match(result.nextStep, /reconcile|read-back/i);
});

test("remove preview identifies the exact item; apply removes it and never touches the library", async (t) => {
  const { library, youtube } = await fixture(t);
  const saved = library.upsertTrack({
    title: "Song One",
    source: { provider: "youtube", sourceId: VID_1 },
    playlist: { provider: "youtube", playlistId: PL_ADMIN, name: "Admin PL" },
  });

  const preview = await removeFromPlaylist({ youtube }, { playlist: PL_ADMIN, videoId: VID_1 });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.item.videoId, VID_1);
  assert.equal(youtube.removeCalls, 0);
  assert.match(preview.note, /library/i);

  const applied = await removeFromPlaylist(
    { youtube },
    { playlist: PL_ADMIN, videoId: VID_1, mode: "apply" },
  );
  assert.equal(applied.writeState, "REMOVED");
  // Removing a playlist item is a provider effect only — the canonical track
  // survives untouched until a separate library operation is authorized.
  assert.equal(library.getTrackById(saved.track.id).canonicalTitle, "Song One");
  assert.ok(library.getTrackBySource("youtube", VID_1));
});

test("remove reports NOT_PRESENT for absent videos and REMOVED for one of duplicate items", async (t) => {
  const { youtube } = await fixture(t);
  youtube.items.get(PL_ADMIN).push({ itemId: "item-dup", id: VID_1, name: "Song One (dup)" });

  const absent = await removeFromPlaylist(
    { youtube },
    { playlist: PL_ADMIN, videoId: "V_ABSENT0001", mode: "apply" },
  );
  assert.equal(absent.writeState, "NOT_PRESENT");

  const applied = await removeFromPlaylist(
    { youtube },
    { playlist: PL_ADMIN, videoId: VID_1, mode: "apply" },
  );
  assert.equal(applied.writeState, "REMOVED");
  const remaining = await youtube.getPlaylistItems(PL_ADMIN);
  assert.equal(remaining.filter((item) => item.id === VID_1).length, 1);
});

test("remove reports UNKNOWN_AFTER_WRITE when post-write read-back is unavailable", async (t) => {
  const { youtube } = await fixture(t);
  youtube.failItemReadOnCall = 2; // match-read succeeds; read-back fails
  const result = await removeFromPlaylist(
    { youtube },
    { playlist: PL_ADMIN, videoId: VID_1, mode: "apply" },
  );
  assert.equal(result.writeState, "UNKNOWN_AFTER_WRITE");
  assert.equal(result.verified, null);
  assert.match(result.nextStep, /verify|read.?back/i);
});

test("remove reports UNKNOWN_AFTER_WRITE when the exact deleted row is still present", async (t) => {
  const { youtube } = await fixture(t);
  // Stub delete reports success but leaves the row behind — read-back must
  // find that exact playlistItemId and refuse to claim REMOVED.
  youtube.removeVideoFromPlaylist = async (playlistId, videoId) => {
    const list = youtube.items.get(playlistId) ?? [];
    const found = list.find((item) => item.id === videoId);
    youtube.removeCalls += 1;
    return { removed: true, playlistItemId: found?.itemId ?? null, videoId };
  };
  const result = await removeFromPlaylist(
    { youtube },
    { playlist: PL_ADMIN, videoId: VID_1, mode: "apply" },
  );
  assert.equal(result.writeState, "UNKNOWN_AFTER_WRITE");
  assert.equal(result.verified, true);
});

test("delete_playlist needs independent confirmation and previews exact id/name/itemCount", async (t) => {
  const { youtube } = await fixture(t);
  const preview = await deletePlaylist({ youtube }, { playlist: PL_ADMIN });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.playlist.id, PL_ADMIN);
  assert.equal(preview.playlist.name, "Admin PL");
  assert.equal(preview.playlist.itemCount, 2);
  assert.equal(youtube.deleteCalls, 0);

  // Apply without the exact-id confirmation refuses to write.
  const refused = await deletePlaylist(
    { youtube },
    { playlist: PL_ADMIN, mode: "apply" },
  );
  assert.equal(refused.writeState, "FAILED_NO_CONFIRMED_EFFECT");
  assert.equal(youtube.deleteCalls, 0);

  const applied = await deletePlaylist(
    { youtube },
    { playlist: PL_ADMIN, mode: "apply", confirmPlaylistId: PL_ADMIN },
  );
  assert.equal(applied.writeState, "DELETED");
  assert.equal(applied.verified, null); // read-back confirms it is gone
});

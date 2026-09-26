import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openLibrary } from "../src/library.js";
import { saveMusic } from "../src/save-music.js";

const VIDEO_ID = "dQw4w9WgXcQ";

function videoFixture(id = VIDEO_ID) {
  return {
    id,
    name: "Daft Punk - One More Time (Official Video)",
    artists: ["Daft Punk"],
    channel: "Daft Punk",
    url: "https://www.youtube.com/watch?v=" + id,
    platform: "youtube",
    description: "Discovery era dance track",
  };
}

function stubYouTube(overrides = {}) {
  const calls = [];
  const playlists = [];
  const items = new Map();
  return {
    env: {},
    calls,
    playlists,
    items,
    async getVideo(id) {
      calls.push(["getVideo", id]);
      return videoFixture(id);
    },
    async searchVideos(query) {
      calls.push(["searchVideos", query]);
      return {
        query,
        total: 2,
        videos: [videoFixture("AAAAAAAAAAA"), videoFixture("BBBBBBBBBBB")],
      };
    },
    async listPlaylists() {
      calls.push(["listPlaylists"]);
      return { total: playlists.length, playlists };
    },
    async getPlaylist(id) {
      calls.push(["getPlaylist", id]);
      const found = playlists.find((playlist) => playlist.id === id);
      if (!found) throw new Error("YouTube playlist was not found: " + id);
      return found;
    },
    async getPlaylistItems(id) {
      calls.push(["getPlaylistItems", id]);
      return items.get(id) ?? [];
    },
    async createPlaylist(name) {
      calls.push(["createPlaylist", name]);
      const created = {
        id: "PL_CREATED_" + (playlists.length + 1),
        name,
        url: "https://www.youtube.com/playlist?list=PL_CREATED_" + (playlists.length + 1),
      };
      playlists.push(created);
      items.set(created.id, []);
      return created;
    },
    async addVideoToPlaylist(playlistId, videoId) {
      calls.push(["addVideoToPlaylist", playlistId, videoId]);
      const entry = { id: videoId, name: "video", url: "https://www.youtube.com/watch?v=" + videoId };
      items.set(playlistId, [...(items.get(playlistId) ?? []), entry]);
      return entry;
    },
    ...overrides,
  };
}

async function tempLibrary() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "save-music-"));
  return {
    directory,
    library: openLibrary(path.join(directory, "library.sqlite")),
  };
}

test("exact YouTube URL apply writes library and YouTube, returning a full receipt", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const receipt = await saveMusic(
      { youtube, library },
      {
        input: "https://music.youtube.com/watch?v=" + VIDEO_ID,
        playlist: "Chill",
        tags: ["fav"],
        category: "Chill",
        mode: "apply",
      },
    );

    assert.equal(receipt.action, "saved");
    assert.equal(receipt.syncState, "synced");
    assert.equal(receipt.video.id, VIDEO_ID);
    assert.equal(receipt.duplicate.level, "DISTINCT_TRACK");
    assert.equal(receipt.library.action, "saved");
    assert.equal(receipt.library.writeState, "SAVED");
    assert.equal(receipt.youtube.action, "added");
    assert.equal(receipt.youtube.playlistAction, "created");
    assert.ok(receipt.completedSteps.includes("youtube_playlist_created"));
    assert.ok(receipt.completedSteps.includes("youtube_video_added"));
    assert.ok(receipt.completedSteps.includes("library_saved"));
    assert.equal(receipt.ids.videoId, VIDEO_ID);
    assert.equal(receipt.ids.playlistId, "PL_CREATED_1");
    assert.ok(receipt.ids.trackId);
    assert.ok(receipt.canonical.canonicalKey.startsWith("ct|"));
    assert.equal(receipt.canonical.state, "created");
    assert.ok(receipt.classification.dimensions.custom_tags.some(
      (entry) => entry.value === "fav" && entry.source === "user",
    ));

    const stored = library.getTrackBySource("youtube", VIDEO_ID);
    assert.equal(stored.id, receipt.ids.trackId);
    assert.deepEqual(
      library.listTrackPlaylists(stored.id),
      [{ provider: "youtube", playlistId: "PL_CREATED_1", name: "Chill" }],
    );
    assert.deepEqual(library.listTags(stored.id).sort(), ["Chill", "fav"]);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("free-text input returns selection_required with candidates and writes nothing", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    for (const mode of ["preview", "apply"]) {
      const receipt = await saveMusic(
        { youtube, library },
        { input: "one more time daft punk", mode },
      );
      assert.equal(receipt.action, "selection_required");
      assert.equal(receipt.mode, mode);
      assert.equal(receipt.candidates.length, 2);
      assert.equal(receipt.candidates[0].id, "AAAAAAAAAAA");
      assert.deepEqual(receipt.completedSteps, []);
      assert.match(receipt.nextStep, /videoId/);
    }
    assert.equal(library.trackCount(), 0);
    assert.equal(youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length, 0);
    assert.equal(youtube.calls.filter(([name]) => name === "createPlaylist").length, 0);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("preview mode computes the plan but writes nothing", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const receipt = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + VIDEO_ID, playlist: "Chill" },
    );
    assert.equal(receipt.mode, "preview");
    assert.equal(receipt.action, "would_save");
    assert.equal(receipt.library.writeState, "PREVIEW");
    assert.equal(receipt.youtube.action, "would_add");
    assert.equal(receipt.youtube.writeState, "PREVIEW");
    assert.equal(receipt.syncState, "preview");
    assert.equal(library.trackCount(), 0);
    assert.equal(youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length, 0);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a second apply of the same videoId is idempotent on both sides", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const args = {
      input: "https://www.youtube.com/watch?v=" + VIDEO_ID,
      playlist: "Chill",
      mode: "apply",
    };
    const first = await saveMusic({ youtube, library }, args);
    const second = await saveMusic({ youtube, library }, args);

    assert.equal(first.action, "saved");
    assert.equal(second.action, "skipped_duplicate");
    assert.equal(second.duplicate.level, "EXACT_SOURCE_DUPLICATE");
    assert.equal(second.duplicate.youtubePlaylistItem, true);
    assert.equal(second.library.action, "existing");
    assert.equal(second.youtube.action, "skipped_duplicate");
    assert.equal(second.ids.trackId, first.ids.trackId);
    assert.equal(second.ids.playlistId, first.ids.playlistId);

    assert.equal(library.trackCount(), 1);
    assert.equal(youtube.items.get("PL_CREATED_1").length, 1);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("library write failure after a YouTube success reports truthful partial state", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  library.close();
  try {
    const receipt = await saveMusic(
      { youtube, library },
      {
        input: "https://www.youtube.com/watch?v=" + VIDEO_ID,
        playlist: "Chill",
        mode: "apply",
      },
    );

    assert.equal(receipt.action, "partial_failure");
    assert.equal(receipt.syncState, "partial");
    assert.equal(receipt.youtube.action, "added");
    assert.equal(receipt.library.action, "failed");
    assert.equal(receipt.library.writeState, "FAILED");
    assert.equal(receipt.library.error.code, "LIBRARY_CLOSED");
    assert.ok(receipt.completedSteps.includes("youtube_video_added"));
    assert.ok(!receipt.completedSteps.includes("library_saved"));
    assert.equal(receipt.ids.playlistId, "PL_CREATED_1");
    assert.match(receipt.nextStep, /re-run the same save_music call/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("ambiguous YouTube write failure returns UNKNOWN_AFTER_WRITE while the library still saves", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube({
    async addVideoToPlaylist() {
      throw Object.assign(new Error("request timed out"), { code: "TIMEOUT" });
    },
  });
  youtube.playlists.push({ id: "PL_EXISTING", name: "Chill" });
  youtube.items.set("PL_EXISTING", []);
  try {
    const receipt = await saveMusic(
      { youtube, library },
      {
        input: "https://www.youtube.com/watch?v=" + VIDEO_ID,
        playlist: "Chill",
        mode: "apply",
      },
    );

    assert.equal(receipt.action, "reconciliation_required");
    assert.equal(receipt.syncState, "unknown");
    assert.equal(receipt.youtube.writeState, "UNKNOWN_AFTER_WRITE");
    assert.equal(receipt.youtube.action, "reconciliation_required");
    assert.equal(receipt.library.writeState, "SAVED");
    assert.ok(receipt.completedSteps.includes("library_saved"));
    assert.equal(receipt.ids.playlistId, "PL_EXISTING");
    assert.ok(receipt.ids.trackId);
    assert.match(receipt.nextStep, /Read the target playlist by exact ID/);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a created playlist followed by a failed add reports PARTIAL_PLAYLIST_CREATED with a safe next step", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube({
    async addVideoToPlaylist() {
      throw Object.assign(new Error("playlistItems.insert rejected"), { status: 400 });
    },
  });
  try {
    const receipt = await saveMusic(
      { youtube, library },
      {
        input: "https://www.youtube.com/watch?v=" + VIDEO_ID,
        playlist: "Brand New List",
        mode: "apply",
      },
    );

    assert.equal(receipt.action, "reconciliation_required");
    assert.equal(receipt.youtube.writeState, "PARTIAL_PLAYLIST_CREATED");
    assert.equal(receipt.youtube.playlistAction, "created");
    assert.equal(receipt.ids.playlistId, "PL_CREATED_1");
    assert.match(receipt.nextStep, /returned playlist ID/);
    assert.equal(receipt.library.writeState, "SAVED");
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("syncToYouTube=false writes only the local library", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const receipt = await saveMusic(
      { youtube, library },
      {
        input: VIDEO_ID,
        mode: "apply",
        syncToYouTube: false,
      },
    );

    assert.equal(receipt.action, "saved");
    assert.equal(receipt.syncState, "not_requested");
    assert.equal(receipt.youtube.action, "disabled");
    assert.equal(receipt.library.writeState, "SAVED");
    assert.equal(receipt.source.kind, "youtube-video");
    assert.equal(library.trackCount(), 1);
    assert.equal(youtube.calls.filter(([name]) => name !== "getVideo").length, 0);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setImmediate } from "node:timers/promises";
import { openLibrary } from "../src/library.js";
import { syncYoutube } from "../src/library-sync.js";
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

test("two concurrent applies for one video and playlist add only one provider row", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  const playlistId = "PL_CONCURRENT001";
  youtube.playlists.push({ id: playlistId, name: "Concurrent" });
  youtube.items.set(playlistId, []);

  let readCount = 0;
  let releaseFirstRead;
  let signalFirstRead;
  let signalSecondVideo;
  const firstRead = new Promise((resolve) => { signalFirstRead = resolve; });
  const secondVideo = new Promise((resolve) => { signalSecondVideo = resolve; });
  const firstReadGate = new Promise((resolve) => { releaseFirstRead = resolve; });
  const originalGetVideo = youtube.getVideo.bind(youtube);
  let videoCount = 0;
  youtube.getVideo = async (id) => {
    const video = await originalGetVideo(id);
    videoCount += 1;
    if (videoCount === 2) signalSecondVideo();
    return video;
  };
  youtube.getPlaylistItems = async (id) => {
    readCount += 1;
    const snapshot = [...(youtube.items.get(id) ?? [])];
    if (readCount === 1) {
      signalFirstRead();
      await firstReadGate;
    }
    return snapshot;
  };

  try {
    const args = { input: "https://www.youtube.com/watch?v=" + VIDEO_ID, playlist: playlistId, mode: "apply" };
    const first = saveMusic({ youtube, library }, args);
    await firstRead;
    const second = saveMusic({ youtube, library }, args);
    await secondVideo;
    await setImmediate();
    assert.equal(youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length, 0);
    releaseFirstRead();

    const receipts = await Promise.all([first, second]);
    assert.deepEqual(receipts.map((receipt) => receipt.youtube.action).sort(), ["added", "skipped_duplicate"]);
    assert.equal(youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length, 1);
    assert.equal(youtube.items.get(playlistId).length, 1);
    assert.equal(library.trackCount(), 1);
    assert.equal(readCount, 2);
  } finally {
    releaseFirstRead();
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent canonical sources add only one playlist row", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  const playlistId = "PL_CANONICAL001";
  youtube.playlists.push({ id: playlistId, name: "Canonical" });
  youtube.items.set(playlistId, []);

  let releaseFirstRead;
  let signalFirstRead;
  let signalSecondVideo;
  const firstRead = new Promise((resolve) => { signalFirstRead = resolve; });
  const secondVideo = new Promise((resolve) => { signalSecondVideo = resolve; });
  const firstReadGate = new Promise((resolve) => { releaseFirstRead = resolve; });
  const originalGetVideo = youtube.getVideo.bind(youtube);
  let videoCount = 0;
  youtube.getVideo = async (id) => {
    const video = await originalGetVideo(id);
    videoCount += 1;
    if (videoCount === 2) signalSecondVideo();
    return video;
  };
  let readCount = 0;
  youtube.getPlaylistItems = async (id) => {
    readCount += 1;
    const snapshot = [...(youtube.items.get(id) ?? [])];
    if (readCount === 1) {
      signalFirstRead();
      await firstReadGate;
    }
    return snapshot;
  };
  youtube.addVideoToPlaylist = async (id, videoId) => {
    youtube.calls.push(["addVideoToPlaylist", id, videoId]);
    const entry = {
      id: videoId,
      name: videoFixture(videoId).name,
      channel: "Daft Punk",
    };
    youtube.items.set(id, [...(youtube.items.get(id) ?? []), entry]);
    return entry;
  };

  try {
    const first = saveMusic({ youtube, library }, {
      input: "https://www.youtube.com/watch?v=AAAAAAAAAAA", playlist: playlistId, mode: "apply",
    });
    await firstRead;
    const second = saveMusic({ youtube, library }, {
      input: "https://www.youtube.com/watch?v=BBBBBBBBBBB", playlist: playlistId, mode: "apply",
    });
    await secondVideo;
    await setImmediate();
    assert.equal(youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length, 0);
    releaseFirstRead();

    const receipts = await Promise.all([first, second]);
    assert.deepEqual(receipts.map((receipt) => receipt.youtube.action).sort(), [
      "added", "skipped_canonical_duplicate",
    ]);
    assert.equal(youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length, 1);
    assert.equal(youtube.items.get(playlistId).length, 1);
    assert.equal(readCount, 2);
  } finally {
    releaseFirstRead();
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent saves create one normalized playlist name", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  let releaseFirstList;
  let signalFirstList;
  let signalSecondVideo;
  const firstList = new Promise((resolve) => { signalFirstList = resolve; });
  const secondVideo = new Promise((resolve) => { signalSecondVideo = resolve; });
  const firstListGate = new Promise((resolve) => { releaseFirstList = resolve; });
  const originalGetVideo = youtube.getVideo.bind(youtube);
  let videoCount = 0;
  youtube.getVideo = async (id) => {
    const video = await originalGetVideo(id);
    videoCount += 1;
    if (videoCount === 2) signalSecondVideo();
    return video;
  };
  let listCount = 0;
  youtube.listPlaylists = async () => {
    listCount += 1;
    const snapshot = { total: youtube.playlists.length, playlists: [...youtube.playlists] };
    if (listCount === 1) {
      signalFirstList();
      await firstListGate;
    }
    return snapshot;
  };

  try {
    const first = saveMusic({ youtube, library }, {
      input: "https://www.youtube.com/watch?v=AAAAAAAAAAA",
      playlist: "New Playlist", remoteDedupe: "source", mode: "apply",
    });
    await firstList;
    const second = saveMusic({ youtube, library }, {
      input: "https://www.youtube.com/watch?v=BBBBBBBBBBB",
      playlist: " new playlist ", remoteDedupe: "source", mode: "apply",
    });
    await secondVideo;
    await setImmediate();
    assert.equal(youtube.calls.filter(([name]) => name === "createPlaylist").length, 0);
    releaseFirstList();

    const receipts = await Promise.all([first, second]);
    assert.deepEqual(receipts.map((receipt) => receipt.youtube.action), ["added", "added"]);
    assert.equal(youtube.calls.filter(([name]) => name === "createPlaylist").length, 1);
    assert.equal(youtube.playlists.length, 1);
    assert.equal(youtube.items.get(youtube.playlists[0].id).length, 2);
    assert.equal(listCount, 2);
  } finally {
    releaseFirstList();
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

// Two different YouTube uploads (video IDs) that canonicalize onto the same
// track, plus a live version that must stay a distinct track.
const SOURCE_A = "AAAAAAAAAAA";
const SOURCE_B = "BBBBBBBBBBB";
const LIVE_VERSION = "CCCCCCCCCCC";

function multiSourceYouTube(overrides = {}) {
  const names = {
    [SOURCE_A]: "Daft Punk - One More Time (Official Video)",
    [SOURCE_B]: "Daft Punk - One More Time (Official Audio)",
    [LIVE_VERSION]: "Daft Punk - One More Time (Live)",
  };
  return stubYouTube({
    async getVideo(id) {
      return { ...videoFixture(id), name: names[id] ?? videoFixture(id).name };
    },
    ...overrides,
  });
}

test("apply does not add a second source of the same canonical track to the playlist by default", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = multiSourceYouTube();
  try {
    const first = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_A, playlist: "Chill", mode: "apply" },
    );
    assert.equal(first.action, "saved");
    const playlistId = first.ids.playlistId;

    const receipt = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_B, playlist: playlistId, mode: "apply" },
    );

    // The local identity decision and the remote playlist decision are both
    // explicit in the receipt.
    assert.equal(receipt.duplicate.level, "SAME_CANONICAL_TRACK");
    assert.equal(receipt.youtube.dedupePolicy, "canonical");
    assert.equal(receipt.youtube.duplicateKind, "canonical_track");
    assert.equal(receipt.youtube.matchedVideoId, SOURCE_A);
    assert.equal(receipt.youtube.action, "skipped_canonical_duplicate");
    assert.equal(receipt.library.action, "saved");
    assert.equal(receipt.library.writeState, "SAVED");
    assert.equal(receipt.action, "saved");
    assert.equal(receipt.syncState, "synced");
    assert.equal(receipt.ids.trackId, first.ids.trackId);
    assert.equal(receipt.ids.playlistId, playlistId);
    assert.match(receipt.nextStep, /remoteDedupe/);

    // One canonical track, two attached sources, one playlist item.
    assert.equal(library.trackCount(), 1);
    assert.equal(library.getTrackBySource("youtube", SOURCE_B).id, first.ids.trackId);
    assert.equal(youtube.items.get(playlistId).length, 1);
    assert.equal(youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length, 1);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("remoteDedupe \"source\" adds a second source of the same canonical track", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = multiSourceYouTube();
  try {
    const first = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_A, playlist: "Chill", mode: "apply" },
    );
    const playlistId = first.ids.playlistId;

    const receipt = await saveMusic(
      { youtube, library },
      {
        input: "https://www.youtube.com/watch?v=" + SOURCE_B,
        playlist: playlistId,
        mode: "apply",
        remoteDedupe: "source",
      },
    );

    assert.equal(receipt.duplicate.level, "SAME_CANONICAL_TRACK");
    assert.equal(receipt.youtube.dedupePolicy, "source");
    assert.equal(receipt.youtube.action, "added");
    assert.equal(receipt.action, "saved");
    assert.equal(receipt.ids.trackId, first.ids.trackId);
    assert.equal(library.trackCount(), 1);
    assert.equal(youtube.items.get(playlistId).length, 2);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("preview reports would_skip_canonical_duplicate and writes nothing", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = multiSourceYouTube();
  try {
    const first = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_A, playlist: "Chill", mode: "apply" },
    );
    const playlistId = first.ids.playlistId;

    const receipt = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_B, playlist: playlistId },
    );

    assert.equal(receipt.mode, "preview");
    assert.equal(receipt.action, "would_save");
    assert.equal(receipt.youtube.action, "would_skip_canonical_duplicate");
    assert.equal(receipt.youtube.duplicateKind, "canonical_track");
    assert.equal(receipt.duplicate.youtubePlaylistItemKind, "canonical_track");
    assert.equal(library.getTrackBySource("youtube", SOURCE_B), null);
    assert.equal(youtube.items.get(playlistId).length, 1);
    assert.equal(youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length, 1);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a distinct version of the same song is not swallowed by canonical remote dedupe", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = multiSourceYouTube();
  try {
    const first = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_A, playlist: "Chill", mode: "apply" },
    );
    const playlistId = first.ids.playlistId;

    const receipt = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + LIVE_VERSION, playlist: playlistId, mode: "apply" },
    );

    // A live version has a different canonical key; it is flagged for review
    // locally but still added remotely instead of being silently skipped.
    assert.equal(receipt.duplicate.level, "POSSIBLE_MATCH");
    assert.equal(receipt.youtube.action, "added");
    assert.equal(receipt.youtube.duplicateKind, null);
    assert.equal(receipt.action, "saved");
    assert.notEqual(receipt.ids.trackId, first.ids.trackId);
    assert.equal(library.trackCount(), 2);
    assert.equal(youtube.items.get(playlistId).length, 2);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical remote dedupe still adds when no sibling source is in the playlist", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = multiSourceYouTube();
  try {
    const first = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_A, mode: "apply", syncToYouTube: false },
    );
    assert.equal(first.action, "saved");

    const receipt = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_B, playlist: "Chill", mode: "apply" },
    );

    assert.equal(receipt.duplicate.level, "SAME_CANONICAL_TRACK");
    assert.equal(receipt.youtube.action, "added");
    assert.equal(receipt.youtube.duplicateKind, null);
    assert.equal(receipt.ids.trackId, first.ids.trackId);
    assert.equal(youtube.items.get(receipt.ids.playlistId).length, 1);
    assert.equal(library.trackCount(), 1);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("canonical remote dedupe catches a same-song playlist item the library never saw", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = multiSourceYouTube();
  try {
    const first = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_A, playlist: "Chill", mode: "apply" },
    );
    assert.equal(first.action, "saved");

    // A second playlist already holds an upload of the same song that is not
    // recorded in the local library at all.
    youtube.playlists.push({ id: "PL_FOREIGN", name: "Chill 2" });
    youtube.items.set("PL_FOREIGN", [{
      id: "ZZZZZZZZZZZ",
      name: "Daft Punk - One More Time (Official Audio)",
      channel: "Daft Punk",
      url: "https://www.youtube.com/watch?v=ZZZZZZZZZZZ",
    }]);

    const receipt = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_B, playlist: "PL_FOREIGN", mode: "apply" },
    );

    assert.equal(receipt.duplicate.level, "SAME_CANONICAL_TRACK");
    assert.equal(receipt.youtube.action, "skipped_canonical_duplicate");
    assert.equal(receipt.youtube.duplicateKind, "canonical_track");
    assert.equal(receipt.youtube.matchedVideoId, "ZZZZZZZZZZZ");
    assert.equal(receipt.syncState, "synced");
    assert.deepEqual(receipt.library.remoteSource, {
      action: "linked", sourceId: "ZZZZZZZZZZZ",
    });
    assert.equal(youtube.items.get("PL_FOREIGN").length, 1);
    assert.equal(library.getTrackBySource("youtube", SOURCE_B).id, first.ids.trackId);
    assert.equal(library.getTrackBySource("youtube", "ZZZZZZZZZZZ")?.id, first.ids.trackId);
    const push = await syncYoutube(
      { library, youtube }, { mode: "preview", direction: "push", playlist: "PL_FOREIGN" },
    );
    assert.equal(push.plan.additions.length, 0);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed metadata-only source link never claims the collection is synced", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = multiSourceYouTube();
  try {
    await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_A, playlist: "Chill", mode: "apply" },
    );
    youtube.playlists.push({ id: "PL_FOREIGN", name: "Chill 2" });
    youtube.items.set("PL_FOREIGN", [{
      id: "ZZZZZZZZZZZ",
      name: "Daft Punk - One More Time (Official Audio)",
      channel: "Daft Punk",
    }]);
    const attachCanonicalSource = library.attachCanonicalSource.bind(library);
    library.attachCanonicalSource = () => {
      throw new Error("library write failed");
    };

    const receipt = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_B, playlist: "PL_FOREIGN", mode: "apply" },
    );
    assert.equal(receipt.action, "reconciliation_required");
    assert.equal(receipt.syncState, "partial");
    assert.equal(receipt.library.remoteSource.action, "failed");
    assert.equal(receipt.youtube.action, "skipped_canonical_duplicate");
    assert.equal(library.getTrackBySource("youtube", "ZZZZZZZZZZZ"), null);
    library.attachCanonicalSource = attachCanonicalSource;
    const retry = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_B, playlist: "PL_FOREIGN", mode: "apply" },
    );
    assert.equal(retry.syncState, "synced");
    assert.equal(library.getTrackBySource("youtube", "ZZZZZZZZZZZ")?.id, retry.ids.trackId);
    assert.equal(youtube.items.get("PL_FOREIGN").length, 1);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a failed sibling-source lookup reports dedupeError and remote evidence still dedupes", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = multiSourceYouTube();
  try {
    const first = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_A, playlist: "Chill", mode: "apply" },
    );
    const playlistId = first.ids.playlistId;

    // The stub records bare item ids; give the entry the real metadata the
    // YouTube API would return so remote canonical-key evidence can apply.
    youtube.items.set(playlistId, [{
      id: SOURCE_A,
      name: "Daft Punk - One More Time (Official Video)",
      channel: "Daft Punk",
      url: "https://www.youtube.com/watch?v=" + SOURCE_A,
    }]);

    library.listTrackSources = () => {
      throw new Error("sources read exploded");
    };

    const receipt = await saveMusic(
      { youtube, library },
      { input: "https://www.youtube.com/watch?v=" + SOURCE_B, playlist: playlistId, mode: "apply" },
    );

    // The degraded lookup is reported, and remote canonical-key evidence
    // still catches the duplicate — the write is not silently attempted.
    assert.equal(receipt.youtube.dedupeError.code, "DEDUPE_LOOKUP_FAILED");
    assert.match(receipt.youtube.dedupeError.message, /sources read exploded/);
    assert.equal(receipt.youtube.action, "skipped_canonical_duplicate");
    assert.equal(receipt.youtube.matchedVideoId, SOURCE_A);
    assert.equal(youtube.items.get(playlistId).length, 1);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an exact source duplicate reports duplicateKind exact_source", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const args = {
      input: "https://www.youtube.com/watch?v=" + VIDEO_ID,
      playlist: "Chill",
      mode: "apply",
    };
    await saveMusic({ youtube, library }, args);
    const receipt = await saveMusic({ youtube, library }, args);

    assert.equal(receipt.action, "skipped_duplicate");
    assert.equal(receipt.youtube.duplicateKind, "exact_source");
    assert.equal(receipt.youtube.matchedVideoId, VIDEO_ID);
    assert.equal(receipt.duplicate.youtubePlaylistItemKind, "exact_source");
    assert.equal(library.trackCount(), 1);
    assert.equal(youtube.items.get(receipt.ids.playlistId).length, 1);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("caller cancellation while queued on the YouTube write lock rejects promptly", async () => {
  const { directory, library } = await tempLibrary();
  let releaseFirstWrite;
  let firstWriteStarted;
  const firstWriteGate = new Promise((resolve) => { releaseFirstWrite = resolve; });
  const firstWriteArrived = new Promise((resolve) => { firstWriteStarted = resolve; });
  const youtube = stubYouTube({
    async addVideoToPlaylist(playlistId, videoId) {
      youtube.calls.push(["addVideoToPlaylist", playlistId, videoId]);
      firstWriteStarted();
      // The first write stays in flight briefly — long enough for the second
      // save to be sitting on the write lock when it is cancelled.
      await firstWriteGate;
      const entry = { id: videoId, name: "video", url: "https://www.youtube.com/watch?v=" + videoId };
      youtube.items.set(playlistId, [...(youtube.items.get(playlistId) ?? []), entry]);
      return entry;
    },
  });
  const controller = new AbortController();
  const args = {
    input: "https://www.youtube.com/watch?v=" + VIDEO_ID,
    playlist: "Chill",
    mode: "apply",
  };
  try {
    const first = saveMusic({ youtube, library }, args);
    // Wait until the first save holds the write lock, then queue the second.
    const queued = saveMusic({ youtube, library }, args, { signal: controller.signal });
    await Promise.race([firstWriteArrived, first]);
    assert.ok(
      youtube.calls.some(([name]) => name === "addVideoToPlaylist"),
      "first save never reached the provider write",
    );
    const cancelSentAt = Date.now();
    controller.abort();
    setTimeout(releaseFirstWrite, 800);
    await assert.rejects(
      queued,
      (error) => error?.code === "CALLER_CANCELLED",
    );
    assert.ok(
      Date.now() - cancelSentAt < 500,
      "queued cancellation waited for the lock holder instead of aborting promptly",
    );
    const receipt = await first;
    assert.equal(receipt.action, "saved");
    assert.equal(youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length, 1);
  } finally {
    releaseFirstWrite?.();
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

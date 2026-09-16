import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openLibrary } from "../src/library.js";
import { persistClassification, classifyMusic } from "../src/classify.js";
import {
  getMusic,
  listMusic,
  listUnsyncedMusic,
  recentMusic,
  reclassifyMusic,
  removeMusic,
  searchLibrary,
  updateMusicClassification,
  updateMusicTags,
} from "../src/library-query.js";

function youtubeSource(id, extra = {}) {
  return {
    provider: "youtube",
    sourceId: id,
    url: "https://www.youtube.com/watch?v=" + id,
    ...extra,
  };
}

function stubYouTube(overrides = {}) {
  const calls = [];
  const items = new Map();
  return {
    env: {},
    calls,
    items,
    async getPlaylistItems(playlistId) {
      return [...(items.get(playlistId) ?? [])];
    },
    async removeVideoFromPlaylist(playlistId, videoId) {
      calls.push(["removeVideoFromPlaylist", playlistId, videoId]);
      const current = items.get(playlistId) ?? [];
      const index = current.findIndex((item) => item === videoId || item?.id === videoId);
      if (index === -1) return { removed: false, playlistId, videoId, reason: "not_in_playlist" };
      const row = current.splice(index, 1)[0];
      return { removed: true, playlistId, videoId, playlistItemId: row?.playlistItemId };
    },
    ...overrides,
  };
}

async function tempLibrary() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "library-query-"));
  return {
    directory,
    library: openLibrary(path.join(directory, "library.sqlite")),
  };
}

async function seedTrack(library, input) {
  const saved = library.upsertTrack({
    title: input.title,
    artist: input.artist,
    genre: input.genre,
    mood: input.mood,
    language: input.language,
    activity: input.activity,
    tags: input.tags ?? [],
    source: input.source ?? youtubeSource(input.videoId ?? "AAAAAAAAAAA"),
    ...(input.playlist ? { playlist: input.playlist } : {}),
  });
  return saved.track;
}

test("search_library finds tracks by title, artist, and dimensions with bounded paging", async () => {
  const { directory, library } = await tempLibrary();
  try {
    await seedTrack(library, {
      title: "夜曲", artist: "周杰倫", genre: "pop", mood: "sad",
      language: "zh", videoId: "AAAAAAAABBB",
    });
    await seedTrack(library, {
      title: "Lemon", artist: "米津玄師", genre: "j-pop",
      language: "ja", videoId: "CCCCCCCCDDD",
    });
    await seedTrack(library, {
      title: "Song About Nothing", artist: "Some Band", genre: "rock",
      videoId: "EEEEEEEEFFF",
    });

    const byTitle = searchLibrary(library, { title: "夜曲" });
    assert.equal(byTitle.total, 1);
    assert.equal(byTitle.items[0].canonicalTitle, "夜曲");

    const byArtist = searchLibrary(library, { artist: "米津" });
    assert.equal(byArtist.total, 1);
    assert.equal(byArtist.items[0].artist, "米津玄師");

    const byGenre = searchLibrary(library, { genre: "j-pop" });
    assert.equal(byGenre.total, 1);

    const byMood = searchLibrary(library, { mood: "sad" });
    assert.equal(byMood.total, 1);

    const byLanguage = searchLibrary(library, { language: "zh" });
    assert.equal(byLanguage.total, 1);

    const combined = searchLibrary(library, { artist: "周", genre: "pop" });
    assert.equal(combined.total, 1);

    const all = searchLibrary(library, { limit: 2, offset: 0 });
    assert.equal(all.items.length, 2);
    assert.equal(all.total, 3);
    const page2 = searchLibrary(library, { limit: 2, offset: 2 });
    assert.equal(page2.items.length, 1);
    assert.notEqual(page2.items[0].id, all.items[0].id);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("search_library filters by tag", async () => {
  const { directory, library } = await tempLibrary();
  try {
    await seedTrack(library, {
      title: "Tagged One", videoId: "GGGGGGGGGGG", tags: ["roadtrip", "chill"],
    });
    await seedTrack(library, { title: "Tagged Two", videoId: "HHHHHHHHHHH", tags: ["chill"] });
    await seedTrack(library, { title: "Untagged", videoId: "IIIIIIIIIII" });

    const result = searchLibrary(library, { tag: "roadtrip" });
    assert.equal(result.total, 1);
    assert.equal(result.items[0].canonicalTitle, "Tagged One");

    const chill = searchLibrary(library, { tag: "chill" });
    assert.equal(chill.total, 2);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("list_music paginates deterministically and clamps the limit", async () => {
  const { directory, library } = await tempLibrary();
  try {
    for (let i = 0; i < 25; i += 1) {
      await seedTrack(library, {
        title: "Track " + String(i).padStart(2, "0"),
        videoId: "VID" + String(i).padStart(8, "0"),
      });
    }

    const page1 = listMusic(library, { limit: 10, offset: 0 });
    const page2 = listMusic(library, { limit: 10, offset: 10 });
    const page3 = listMusic(library, { limit: 10, offset: 20 });
    assert.equal(page1.total, 25);
    assert.equal(page1.items.length, 10);
    assert.equal(page2.items.length, 10);
    assert.equal(page3.items.length, 5);
    const ids = new Set([...page1.items, ...page2.items, ...page3.items].map((t) => t.id));
    assert.equal(ids.size, 25);
    // Newest first.
    assert.equal(page1.items[0].canonicalTitle, "Track 24");

    const capped = listMusic(library, { limit: 500 });
    assert.ok(capped.limit <= 100);
    assert.equal(capped.items.length, 25);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("recent_music returns newest saved tracks within a bounded limit", async () => {
  const { directory, library } = await tempLibrary();
  try {
    for (let i = 0; i < 5; i += 1) {
      await seedTrack(library, { title: "Recent " + i, videoId: "REC" + String(i).padStart(8, "0") });
    }
    const recent = recentMusic(library, { limit: 3 });
    assert.equal(recent.items.length, 3);
    assert.equal(recent.items[0].canonicalTitle, "Recent 4");
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("get_music returns the full track record: sources, tags, playlists, classification", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const classification = await classifyMusic({
      title: "Golden", artist: "HUNTR/X",
      userClassification: { mood: "energetic", custom_tags: ["kpop-fav"] },
    });
    const saved = persistClassification(
      library,
      {
        title: "Golden", artist: "HUNTR/X",
        source: youtubeSource("KKKKKKKKKKK", { channelTitle: "HUNTR/X" }),
        playlist: { provider: "youtube", playlistId: "PL_GOLD", name: "K-Pop" },
      },
      classification,
    );

    const detail = getMusic(library, { trackId: saved.trackId });
    assert.equal(detail.track.canonicalTitle, "Golden");
    assert.equal(detail.sources.length, 1);
    assert.equal(detail.sources[0].provider, "youtube");
    assert.equal(detail.sources[0].sourceId, "KKKKKKKKKKK");
    assert.deepEqual(detail.tags.sort(), ["kpop-fav"]);
    assert.deepEqual(detail.playlists, [
      { provider: "youtube", playlistId: "PL_GOLD", name: "K-Pop" },
    ]);
    assert.equal(detail.classification.dimensions.mood[0].value, "energetic");
    assert.equal(detail.classification.dimensions.mood[0].source, "user");

    assert.throws(() => getMusic(library, { trackId: 99999 }), /does not exist|invalid/i);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("update_music_tags adds and removes tags without touching other dimensions", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const track = await seedTrack(library, {
      title: "Tag Me", genre: "rock", mood: "calm",
      videoId: "LLLLLLLLLLL", tags: ["oldtag", "keepme"],
    });

    const result = updateMusicTags(library, {
      trackId: track.id,
      add: ["newtag", "keepme"],
      remove: ["oldtag", "missing"],
    });
    assert.deepEqual(result.before.sort(), ["keepme", "oldtag"]);
    assert.deepEqual(result.after.sort(), ["keepme", "newtag"]);
    assert.deepEqual(result.added, ["newtag"]);
    assert.deepEqual(result.removed, ["oldtag"]);

    const after = library.getTrackById(track.id);
    assert.equal(after.genre, "rock");
    assert.equal(after.mood, "calm");
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("reclassify_music recomputes rule dimensions but preserves user-set values, returning a diff", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const first = await classifyMusic({
      title: "Lemon", artist: "米津玄師", channelTitle: "米津玄師",
      userClassification: { mood: "energetic", custom_tags: ["fav"] },
    });
    const saved = persistClassification(
      library,
      {
        title: "Lemon", artist: "米津玄師",
        source: youtubeSource("MMMMMMMMMMM", { channelTitle: "米津玄師" }),
      },
      first,
    );
    assert.equal(saved.classification.provenance.mood, "user");

    const result = await reclassifyMusic(library, { trackId: saved.trackId });
    assert.equal(result.trackId, saved.trackId);
    // User-set dimension survives the rerun.
    assert.equal(result.after.dimensions.mood[0].value, "energetic");
    assert.equal(result.after.dimensions.mood[0].source, "user");
    // User custom tags survive.
    assert.ok(result.after.dimensions.custom_tags.some(
      (entry) => entry.value === "fav" && entry.source === "user",
    ));
    assert.ok(result.preserved.includes("mood"));
    assert.ok(result.before);
    assert.ok(result.after);
    assert.ok(result.diff);
    assert.equal(typeof result.diff, "object");

    // The stored record matches what was returned.
    const detail = getMusic(library, { trackId: saved.trackId });
    assert.equal(detail.classification.dimensions.mood[0].value, "energetic");
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("remove_music previews by default and writes nothing", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const track = await seedTrack(library, {
      title: "Delete Me", videoId: "NNNNNNNNNNN", tags: ["t"],
      playlist: { provider: "youtube", playlistId: "PL_DEL", name: "Doomed" },
    });

    const preview = await removeMusic({ library, youtube }, { trackId: track.id });
    assert.equal(preview.mode, "preview");
    assert.equal(preview.track.id, track.id);
    assert.equal(library.getTrackById(track.id)?.id, track.id);
    assert.equal(youtube.calls.length, 0);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("remove_music apply with only local authorization deletes locally and never calls YouTube", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const track = await seedTrack(library, {
      title: "Local Delete", videoId: "OOOOOOOOOOO", tags: ["t"],
      playlist: { provider: "youtube", playlistId: "PL_LOCAL", name: "Mine" },
    });
    youtube.items.set("PL_LOCAL", ["OOOOOOOOOOO"]);

    const result = await removeMusic({ library, youtube }, { trackId: track.id, mode: "apply", local: true });
    assert.equal(result.action, "removed");
    assert.equal(result.effects.local.writeState, "REMOVED");
    assert.equal(library.getTrackById(track.id), null);
    assert.equal(library.listTags(track.id).length, 0);
    // The YouTube side was not authorized: no call, item still present.
    assert.equal(youtube.calls.length, 0);
    assert.deepEqual(youtube.items.get("PL_LOCAL"), ["OOOOOOOOOOO"]);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("remove_music apply with only YouTube authorization keeps the local track", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const track = await seedTrack(library, {
      title: "Remote Delete", videoId: "PPPPPPPPPPP",
      playlist: { provider: "youtube", playlistId: "PL_REMOTE", name: "Theirs" },
    });
    youtube.items.set("PL_REMOTE", ["PPPPPPPPPPP"]);

    const result = await removeMusic({ library, youtube }, {
      trackId: track.id,
      mode: "apply",
      youtubePlaylist: "PL_REMOTE",
    });
    assert.equal(result.effects.youtubePlaylistItem.writeState, "REMOVED");
    assert.deepEqual(youtube.calls, [["removeVideoFromPlaylist", "PL_REMOTE", "PPPPPPPPPPP"]]);
    assert.equal(library.getTrackById(track.id)?.id, track.id);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("remove_music reports UNKNOWN_AFTER_WRITE when the provider row survives or read-back fails", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const track = await seedTrack(library, {
      title: "Remote Delete", videoId: "PPPPPPPPPPP",
      playlist: { provider: "youtube", playlistId: "PL_REMOTE", name: "Theirs" },
    });

    // An adapter that claims success but leaves the exact row in place.
    const lying = stubYouTube({
      async removeVideoFromPlaylist(playlistId, videoId) {
        return { removed: true, playlistId, videoId, playlistItemId: "PLI_ROW" };
      },
      async getPlaylistItems() {
        return [{ id: "PPPPPPPPPPP", playlistItemId: "PLI_ROW" }];
      },
    });
    const unverified = await removeMusic({ library, youtube: lying }, {
      trackId: track.id,
      mode: "apply",
      youtubePlaylist: "PL_REMOTE",
    });
    assert.equal(unverified.effects.youtubePlaylistItem.writeState, "UNKNOWN_AFTER_WRITE");
    assert.equal(unverified.effects.youtubePlaylistItem.verified.present, true);
    assert.match(unverified.effects.youtubePlaylistItem.nextStep, /exact ID/);

    // Read-back failure is uncertainty, not confirmation.
    const unreadable = stubYouTube({
      async removeVideoFromPlaylist(playlistId, videoId) {
        return { removed: true, playlistId, videoId, playlistItemId: "PLI_ROW" };
      },
      async getPlaylistItems() {
        throw new Error("read-back unavailable");
      },
    });
    const unknown = await removeMusic({ library, youtube: unreadable }, {
      trackId: track.id,
      mode: "apply",
      youtubePlaylist: "PL_REMOTE",
    });
    assert.equal(unknown.effects.youtubePlaylistItem.writeState, "UNKNOWN_AFTER_WRITE");
    assert.equal(unknown.effects.youtubePlaylistItem.verified.present, null);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("remove_music apply without any authorized effect is an explicit no-op", async () => {
  const { directory, library } = await tempLibrary();
  const youtube = stubYouTube();
  try {
    const track = await seedTrack(library, { title: "Keep Me", videoId: "QQQQQQQQQQQ" });
    const result = await removeMusic({ library, youtube }, { trackId: track.id, mode: "apply" });
    assert.equal(result.action, "no_effect_authorized");
    assert.equal(library.getTrackById(track.id)?.id, track.id);
    assert.equal(youtube.calls.length, 0);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("list_unsynced_music reports not-synced, identity-conflict, and provider-unavailable tracks", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const synced = await seedTrack(library, {
      title: "Synced", videoId: "RRRRRRRRRRR",
      playlist: { provider: "youtube", playlistId: "PL_OK", name: "Ok" },
    });
    const localOnly = await seedTrack(library, { title: "Local Only", videoId: "SSSSSSSSSSS" });
    const conflict = await seedTrack(library, { title: "Conflicted", videoId: "TTTTTTTTTTT" });
    library.setNeedsReview(conflict.id, true);
    const unavailable = await seedTrack(library, { title: "Unavailable", videoId: "UUUUUUUUUUU" });
    library.setSyncState("sync." + unavailable.id, { state: "provider_unavailable", provider: "youtube" });

    const result = listUnsyncedMusic(library, {});
    const byId = new Map(result.items.map((entry) => [entry.track.id, entry.reasons]));
    assert.ok(!byId.has(synced.id));
    assert.ok(byId.get(localOnly.id).includes("not_synced"));
    assert.ok(byId.get(conflict.id).includes("identity_conflict"));
    assert.ok(byId.get(conflict.id).includes("not_synced"));
    assert.ok(byId.get(unavailable.id).includes("provider_unavailable"));

    const onlyConflict = listUnsyncedMusic(library, { reason: "identity_conflict" });
    assert.equal(onlyConflict.items.length, 1);
    assert.equal(onlyConflict.items[0].track.id, conflict.id);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("update_music_classification preview shows before/after diff without writing", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const track = await seedTrack(library, { title: "Edit Me", videoId: "ED123456789" });
    const preview = updateMusicClassification(library, {
      trackId: track.id,
      set: { genre: "j-pop", language: "ja", mood: "energetic" },
    });
    assert.equal(preview.mode, "preview");
    assert.equal(preview.after.provenance.genre, "user");
    assert.equal(preview.diff.genre.added[0], "j-pop");
    // Preview wrote nothing: no stored record, no field change.
    assert.equal(getMusic(library, { trackId: track.id }).classification, null);
    assert.equal(library.getTrackById(track.id).genre, null);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("user-set dimensions persist as source user and survive reclassify", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const track = await seedTrack(library, { title: "Stay JPop", videoId: "JP123456789" });
    const applied = updateMusicClassification(library, {
      trackId: track.id,
      set: { genre: "j-pop", language: "ja" },
      mode: "apply",
    });
    assert.equal(applied.mode, "apply");
    assert.equal(applied.track.genre, "j-pop");
    assert.equal(applied.track.language, "ja");
    const stored = getMusic(library, { trackId: track.id }).classification;
    assert.equal(stored.provenance.genre, "user");
    assert.equal(stored.dimensions.genre[0].source, "user");

    const again = await reclassifyMusic(library, { trackId: track.id });
    assert.equal(again.after.dimensions.genre[0].value, "j-pop");
    assert.ok(again.preserved.includes("genre") || again.after.provenance.genre === "user");
    assert.equal(library.getTrackById(track.id).genre, "j-pop");
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("clear removes only the user dimension; other dims and tags untouched", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const track = await seedTrack(library, { title: "Clear Mood", videoId: "CL123456789" });
    updateMusicClassification(library, {
      trackId: track.id,
      set: { mood: "energetic", genre: "j-pop" },
      mode: "apply",
    });
    const cleared = updateMusicClassification(library, {
      trackId: track.id,
      clear: ["mood"],
      mode: "apply",
    });
    assert.equal(cleared.track.mood, null);
    assert.equal(cleared.track.genre, "j-pop");
    const stored = getMusic(library, { trackId: track.id }).classification;
    assert.equal(stored.dimensions.mood.filter((e) => e.source === "user").length, 0);
    assert.equal(stored.dimensions.genre[0].value, "j-pop");
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown values divert to custom_tags + needsReview, never pollute taxonomy", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const track = await seedTrack(library, { title: "Odd Genre", videoId: "OD123456789" });
    const applied = updateMusicClassification(library, {
      trackId: track.id,
      set: { genre: "hyper-fusion-3000" },
      mode: "apply",
    });
    const stored = getMusic(library, { trackId: track.id }).classification;
    assert.equal(stored.dimensions.genre.length, 0); // not an official value
    assert.ok(stored.dimensions.custom_tags.some((e) => e.value === "hyper-fusion-3000"));
    assert.ok(applied.needsReview.some((e) => e.dimension === "genre"));
    assert.ok(library.listTags(track.id).includes("hyper-fusion-3000"));
    assert.equal(library.getTrackById(track.id).genre, null);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a prior user value retired from the taxonomy diverts instead of failing", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const track = await seedTrack(library, { title: "Retired", videoId: "RE123456789" });
    // Simulate a stored record whose user value was official under an older
    // taxonomy: any subsequent edit must divert it, not crash validation.
    library.setSyncState(`classification.${track.id}`, {
      taxonomyVersion: "v0-legacy",
      dimensions: {
        genre: [{ value: "retired-genre-x", source: "user", confidence: 1 }],
        mood: [{ value: "calm", source: "user", confidence: 1 }],
        custom_tags: [],
      },
      provenance: { genre: "user", mood: "user" },
      needsReview: [],
    });
    const applied = updateMusicClassification(library, {
      trackId: track.id,
      set: { language: "ja" },
      mode: "apply",
    });
    const stored = getMusic(library, { trackId: track.id }).classification;
    assert.equal(stored.dimensions.genre.length, 0);
    assert.ok(stored.dimensions.custom_tags.some((e) => e.value === "retired-genre-x"));
    assert.ok(applied.needsReview.some((e) => e.dimension === "genre" && e.value === "retired-genre-x"));
    assert.ok(library.listTags(track.id).includes("retired-genre-x"));
    // A still-valid prior user value keeps its place untouched.
    assert.equal(stored.dimensions.mood[0].value, "calm");
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("empty or null set values never silently clear a dimension", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const track = await seedTrack(library, { title: "No Sneak Clear", videoId: "NS123456789" });
    updateMusicClassification(library, {
      trackId: track.id,
      set: { mood: "calm" },
      mode: "apply",
    });
    const applied = updateMusicClassification(library, {
      trackId: track.id,
      set: { mood: [] },
      mode: "apply",
    });
    assert.equal(applied.track.mood, "calm");
    const appliedNull = updateMusicClassification(library, {
      trackId: track.id,
      set: { mood: null },
      mode: "apply",
    });
    assert.equal(appliedNull.track.mood, "calm");
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("synonyms normalize through the taxonomy; unknown dimension names are rejected", async () => {
  const { directory, library } = await tempLibrary();
  try {
    const track = await seedTrack(library, { title: "Synonym", videoId: "SY123456789" });
    const applied = updateMusicClassification(library, {
      trackId: track.id,
      set: { genre: "J-POP" },
      mode: "apply",
    });
    assert.equal(applied.track.genre, "j-pop");
    assert.throws(
      () => updateMusicClassification(library, { trackId: track.id, set: { vibe: "x" } }),
      /Unknown classification dimension/,
    );
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

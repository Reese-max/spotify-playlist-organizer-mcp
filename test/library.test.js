import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  LibraryStore,
  LibraryStoreError,
  libraryDbPath,
  MIGRATIONS,
  SCHEMA_VERSION,
} from "../src/library.js";

async function tempLibrary() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-library-"));
  return {
    directory,
    dbPath: path.join(directory, "library.db"),
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

const baseTrack = {
  title: "One More Time",
  artist: "Daft Punk",
  album: "Discovery",
  language: "en",
  genre: "electronic",
  mood: "energetic",
  activity: "party",
  durationMs: 320_000,
  sources: [{
    provider: "youtube",
    videoId: "dQw4w9WgXcQ",
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    versionType: "official",
    channel: "Daft Punk",
    isPrimary: true,
  }],
  tags: ["Party"],
  playlists: [{ name: "Party", provider: "youtube", providerPlaylistId: "PL_PARTY", category: "Party" }],
  aliases: [{ alias: "one more time daft punk", kind: "query" }],
  sync: { provider: "youtube", providerPlaylistId: "PL_PARTY", status: "synced", detail: "added" },
};

test("resolves the default library path and honors MUSIC_LIBRARY_DB", () => {
  const custom = libraryDbPath({ MUSIC_LIBRARY_DB: " ./data/my-library.db " });
  assert.equal(custom, path.resolve("./data/my-library.db"));

  const fallback = libraryDbPath({
    HOME: "/home/example",
    XDG_CONFIG_HOME: "",
    APPDATA: "",
    USERPROFILE: "",
    MUSIC_LIBRARY_DB: "",
  });
  assert.equal(
    fallback,
    path.join("/home/example", ".config", "music-playlist-organizer", "library.db"),
  );
});

test("initializes the database, schema version, and status on first open", async () => {
  const { directory, dbPath, cleanup } = await tempLibrary();
  try {
    const store = new LibraryStore({}, dbPath);
    assert.equal(store.schemaVersion, null);
    store.open();
    assert.equal(store.schemaVersion, SCHEMA_VERSION);

    const tables = new Set(
      store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map((row) => row.name),
    );
    for (const table of [
      "schema_migrations",
      "tracks",
      "track_sources",
      "playlists",
      "track_playlists",
      "tags",
      "track_tags",
      "aliases",
      "sync_state",
    ]) {
      assert.ok(tables.has(table), "missing table " + table);
    }

    const status = store.status();
    assert.equal(status.status, "READY");
    assert.equal(status.dbPath, dbPath);
    assert.equal(status.schemaVersion, SCHEMA_VERSION);
    assert.deepEqual(status.counts, {
      tracks: 0,
      sources: 0,
      playlists: 0,
      tags: 0,
    });
    store.close();
    assert.equal(store.schemaVersion, null);
    assert.equal((await import("node:fs")).existsSync(dbPath), true);
  } finally {
    await cleanup();
  }
});

test("upserts a track with its YouTube source idempotently", async () => {
  const { dbPath, cleanup } = await tempLibrary();
  try {
    const store = new LibraryStore({}, dbPath);
    const first = store.saveTrack(baseTrack);
    assert.equal(first.created, true);

    const second = store.saveTrack({ ...baseTrack, mood: "euphoric" });
    assert.equal(second.created, false);
    assert.equal(second.trackId, first.trackId);

    const status = store.status();
    assert.equal(status.counts.tracks, 1);
    assert.equal(status.counts.sources, 1);
    assert.equal(status.counts.playlists, 1);
    assert.equal(status.counts.tags, 1);

    const track = store.getTrack(first.trackId);
    assert.equal(track.mood, "euphoric");
    assert.equal(track.sources.length, 1);
    assert.equal(track.sources[0].videoId, "dQw4w9WgXcQ");
    assert.deepEqual(track.tags, ["Party"]);
    assert.equal(track.playlists[0].providerPlaylistId, "PL_PARTY");
    assert.equal(track.sync[0].status, "synced");
    store.close();
  } finally {
    await cleanup();
  }
});

test("deduplicates by YouTube video ID even when the title differs", async () => {
  const { dbPath, cleanup } = await tempLibrary();
  try {
    const store = new LibraryStore({}, dbPath);
    const first = store.saveTrack(baseTrack);
    const second = store.saveTrack({
      title: "One More Time (Official Video)",
      artist: "Daft Punk",
      sources: [{ provider: "youtube", videoId: "dQw4w9WgXcQ" }],
    });
    assert.equal(second.trackId, first.trackId);
    assert.equal(second.created, false);
    assert.equal(store.status().counts.tracks, 1);
    assert.equal(store.status().counts.sources, 1);
    store.close();
  } finally {
    await cleanup();
  }
});

test("refreshes track metadata on repeat saves without duplicating", async () => {
  const { dbPath, cleanup } = await tempLibrary();
  try {
    const store = new LibraryStore({}, dbPath);
    const first = store.saveTrack(baseTrack);
    const second = store.saveTrack({
      title: "One More Time (Remastered)",
      artist: "Daft Punk",
      album: "Discovery (Remastered)",
      sources: [{
        provider: "youtube",
        videoId: "dQw4w9WgXcQ",
        versionType: "remaster",
        isPrimary: false,
      }],
    });
    assert.equal(second.trackId, first.trackId);
    assert.equal(second.created, false);
    assert.equal(store.status().counts.tracks, 1);

    const track = store.getTrack(first.trackId);
    assert.equal(track.title, "One More Time (Remastered)");
    assert.equal(track.album, "Discovery (Remastered)");
    assert.equal(track.sources[0].versionType, "remaster");
    assert.equal(track.sources[0].isPrimary, false);
    store.close();
  } finally {
    await cleanup();
  }
});

test("persists tracks, tags, and sync state across process restarts", async () => {
  const { dbPath, cleanup } = await tempLibrary();
  try {
    const first = new LibraryStore({}, dbPath);
    const saved = first.saveTrack(baseTrack);
    first.close();

    const reopened = new LibraryStore({}, dbPath);
    reopened.open();
    assert.equal(reopened.schemaVersion, SCHEMA_VERSION);
    const track = reopened.getTrack(saved.trackId);
    assert.equal(track.title, "One More Time");
    assert.deepEqual(track.tags, ["Party"]);
    assert.equal(track.sync[0].providerPlaylistId, "PL_PARTY");
    assert.equal(track.sync[0].status, "synced");

    const byVideo = reopened.findTrackByVideoId("dQw4w9WgXcQ");
    assert.equal(byVideo.id, saved.trackId);
    reopened.close();
  } finally {
    await cleanup();
  }
});

test("applies pending migrations in order without deleting the database", async () => {
  const { dbPath, cleanup } = await tempLibrary();
  try {
    const store = new LibraryStore({}, dbPath);
    store.saveTrack(baseTrack);
    assert.equal(store.schemaVersion, SCHEMA_VERSION);

    const future = new LibraryStore({}, dbPath, {
      migrations: [
        ...MIGRATIONS,
        { version: SCHEMA_VERSION + 1, name: "test_v2", sql: "ALTER TABLE tracks ADD COLUMN future_note TEXT" },
      ],
    });
    future.open();
    assert.equal(future.schemaVersion, SCHEMA_VERSION + 1);
    const columns = future.db.prepare("PRAGMA table_info(tracks)").all().map((c) => c.name);
    assert.ok(columns.includes("future_note"));
    assert.equal(future.status().counts.tracks, 1);
    future.close();
  } finally {
    await cleanup();
  }
});

test("refuses to open a database written by a newer schema version", async () => {
  const { dbPath, cleanup } = await tempLibrary();
  try {
    const seed = new Database(dbPath);
    seed.pragma("user_version = " + (SCHEMA_VERSION + 5));
    seed.close();

    const store = new LibraryStore({}, dbPath);
    assert.throws(() => store.open(), (error) => error.code === "LIBRARY_SCHEMA_TOO_NEW");
    assert.equal(store.schemaVersion, null);

    const probe = new Database(dbPath, { readonly: true });
    assert.equal(probe.pragma("user_version", { simple: true }), SCHEMA_VERSION + 5);
    probe.close();
  } finally {
    await cleanup();
  }
});

test("rolls back the whole save when a later write violates the schema", async () => {
  const { dbPath, cleanup } = await tempLibrary();
  try {
    const store = new LibraryStore({}, dbPath);
    assert.throws(
      () => store.saveTrack({ ...baseTrack, sync: { provider: "youtube", status: "bogus" } }),
      (error) => error instanceof LibraryStoreError && error.code === "LIBRARY_WRITE_FAILED",
    );
    assert.equal(store.status().counts.tracks, 0);
    assert.equal(store.findTrackByVideoId("dQw4w9WgXcQ"), null);
    store.close();
  } finally {
    await cleanup();
  }
});

test("keeps tokens, secrets, and passphrases out of the database and status output", async () => {
  const { dbPath, cleanup } = await tempLibrary();
  const env = {
    YOUTUBE_ACCESS_TOKEN: "sentinel-access-token",
    YOUTUBE_REFRESH_TOKEN: "sentinel-refresh-token",
    GOOGLE_CLIENT_SECRET: "sentinel-client-secret",
    YOUTUBE_CREDENTIAL_PASSPHRASE: "sentinel-passphrase",
    MUSIC_LIBRARY_DB: dbPath,
  };
  try {
    const store = new LibraryStore(env);
    assert.equal(store.dbPath, dbPath);
    store.saveTrack(baseTrack);
    const statusJson = JSON.stringify(store.status());
    store.close();

    const raw = await readFile(dbPath);
    for (const sentinel of [
      "sentinel-access-token",
      "sentinel-refresh-token",
      "sentinel-client-secret",
      "sentinel-passphrase",
    ]) {
      assert.equal(raw.includes(sentinel), false, "database contains " + sentinel);
      assert.equal(statusJson.includes(sentinel), false, "status contains " + sentinel);
    }
  } finally {
    await cleanup();
  }
});

test("lists tracks with bounded pagination and artist/tag/sync filters", async () => {
  const { dbPath, cleanup } = await tempLibrary();
  try {
    const store = new LibraryStore({}, dbPath);
    store.saveTrack(baseTrack);
    store.saveTrack({
      title: "Harder Better Faster Stronger",
      artist: "Daft Punk",
      sources: [{ provider: "youtube", videoId: "HbFs0aaaAAA" }],
      tags: ["Workout"],
    });
    store.saveTrack({
      title: "Never Gonna Give You Up",
      artist: "Rick Astley",
      sources: [{ provider: "youtube", videoId: "AaBbCcDdEeF" }],
      tags: ["Party"],
      sync: { provider: "youtube", status: "failed", detail: "quota" },
    });

    const all = store.listTracks({ limit: 10 });
    assert.equal(all.total, 3);
    assert.equal(all.tracks.length, 3);

    const paged = store.listTracks({ limit: 2, offset: 2 });
    assert.equal(paged.tracks.length, 1);
    assert.equal(paged.total, 3);

    const byArtist = store.listTracks({ artist: "daft punk" });
    assert.equal(byArtist.total, 2);

    const byTag = store.listTracks({ tag: "party" });
    assert.equal(byTag.total, 2);

    const synced = store.listTracks({ synced: true });
    assert.equal(synced.total, 1);
    const pending = store.listTracks({ synced: false });
    assert.equal(pending.total, 2);

    assert.throws(
      () => store.listTracks({ limit: 10_000 }),
      (error) => error.code === "LIBRARY_QUERY_INVALID" || error instanceof Error,
    );
    store.close();
  } finally {
    await cleanup();
  }
});

test("rejects invalid input without touching the database", async () => {
  const { dbPath, cleanup } = await tempLibrary();
  try {
    const store = new LibraryStore({}, dbPath);
    assert.throws(() => store.saveTrack({}), (error) => error.code === "LIBRARY_TRACK_INVALID");
    assert.throws(
      () => store.saveTrack({ title: "x", sources: [{ provider: "youtube" }] }),
      (error) => error.code === "LIBRARY_TRACK_INVALID",
    );
    assert.equal(store.status().counts?.tracks ?? 0, 0);
    store.close();
  } finally {
    await cleanup();
  }
});

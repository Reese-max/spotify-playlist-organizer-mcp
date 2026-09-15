import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  LibraryError,
  MusicLibrary,
  libraryFilePath,
  openLibrary,
} from "../src/library.js";

async function tempLibrary() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-library-"));
  return { directory, filePath: path.join(directory, "library.sqlite") };
}

test("libraryFilePath honors MUSIC_LIBRARY_FILE and the config-dir default", () => {
  const custom = libraryFilePath({ MUSIC_LIBRARY_FILE: "relative/path/library.sqlite" });
  assert.equal(custom, path.resolve("relative/path/library.sqlite"));

  const fallback = libraryFilePath({
    MUSIC_LIBRARY_FILE: "",
    APPDATA: path.join(os.tmpdir(), "fake-appdata"),
    USERPROFILE: "C:\\Users\\Tester",
  });
  assert.equal(
    fallback,
    path.join(os.tmpdir(), "fake-appdata", "music-playlist-organizer", "library.sqlite"),
  );
});

test("first open initializes the schema version", async () => {
  const { directory, filePath } = await tempLibrary();
  try {
    const library = openLibrary({ MUSIC_LIBRARY_FILE: filePath });
    assert.equal(library.schemaVersion(), 1);
    library.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("upsert of the same youtube source is idempotent and keeps saved_at", async () => {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  try {
    const first = library.upsertTrack({
      title: "One More Time",
      artist: "Daft Punk",
      genre: "dance",
      source: {
        provider: "youtube",
        sourceId: "dQw4w9WgXcQ",
        url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      },
      tags: ["party"],
    });
    assert.equal(first.created, true);
    assert.equal(first.writeState, "SAVED");
    assert.equal(first.track.canonicalTitle, "One More Time");

    const second = library.upsertTrack({
      title: "One More Time",
      artist: "Daft Punk",
      mood: "energetic",
      source: { provider: "youtube", sourceId: "dQw4w9WgXcQ" },
    });
    assert.equal(second.created, false);
    assert.equal(second.track.id, first.track.id);
    assert.equal(library.trackCount(), 1);
    assert.equal(second.track.savedAt, first.track.savedAt);
    assert.equal(second.track.mood, "energetic");
    assert.equal(second.track.genre, "dance");
    assert.ok(Date.parse(second.track.updatedAt) >= Date.parse(second.track.savedAt));
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("close and reopen keeps tracks, tags, playlists, and sync_state", async () => {
  const { directory, filePath } = await tempLibrary();
  let library = openLibrary(filePath);
  const saved = library.upsertTrack({
    title: "Ditto",
    artist: "NewJeans",
    language: "ko",
    source: { provider: "youtube", sourceId: "pSUydWEqKwE" },
    tags: ["kpop", "winter"],
    playlist: { provider: "youtube", playlistId: "PLabc123", name: "K-pop" },
  });
  library.setSyncState("youtube.lastPull", "2026-09-15T00:00:00.000Z");
  library.close();

  try {
    library = openLibrary(filePath);
    const track = library.getTrackBySource("youtube", "pSUydWEqKwE");
    assert.equal(track.id, saved.track.id);
    assert.equal(track.canonicalTitle, "Ditto");
    assert.equal(library.getTrackById(saved.track.id).artist, "NewJeans");
    assert.deepEqual(library.listTags(track.id), ["kpop", "winter"]);
    assert.equal(library.getSyncState("youtube.lastPull"), "2026-09-15T00:00:00.000Z");
    assert.equal(library.getSyncState(" youtube.lastPull "), "2026-09-15T00:00:00.000Z");
    assert.equal(library.listRecent(10).length, 1);
    assert.deepEqual(library.listTrackPlaylists(track.id), [
      { provider: "youtube", playlistId: "PLabc123", name: "K-pop" },
    ]);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("migrates a pre-schema database forward without deleting data", async () => {
  const { directory, filePath } = await tempLibrary();
  try {
    const raw = new DatabaseSync(filePath);
    raw.exec(`CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    raw.exec(`CREATE TABLE tracks (
      id INTEGER PRIMARY KEY,
      canonical_title TEXT NOT NULL,
      artist TEXT,
      language TEXT,
      genre TEXT,
      mood TEXT,
      activity TEXT,
      energy TEXT,
      era TEXT,
      saved_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`);
    raw
      .prepare("INSERT INTO tracks (canonical_title, artist, saved_at, updated_at) VALUES (?, ?, ?, ?)")
      .run("Pre-existing Song", "Someone", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    raw.close();

    const library = openLibrary(filePath);
    try {
      assert.equal(library.schemaVersion(), 1);
      const track = library.getTrackById(1);
      assert.equal(track.canonicalTitle, "Pre-existing Song");
      assert.equal(library.trackCount(), 1);
    } finally {
      library.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider + source_id uniqueness prevents duplicate tracks", async () => {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  try {
    for (let index = 0; index < 3; index += 1) {
      library.upsertTrack({
        title: "Repeat",
        source: { provider: "youtube", sourceId: "same-video-id" },
      });
    }
    assert.equal(library.trackCount(), 1);
    const track = library.getTrackBySource("youtube", "same-video-id");
    assert.equal(track.canonicalTitle, "Repeat");

    library.upsertTrack({
      title: "Other",
      source: { provider: "youtube", sourceId: "other-video-id" },
    });
    assert.equal(library.trackCount(), 2);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects secret-looking input keys and never writes them to the file", async () => {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  try {
    assert.throws(
      () => library.upsertTrack({
        title: "Leaky",
        accessToken: "access-token-secret",
        source: { provider: "youtube", sourceId: "leak-1" },
      }),
      (error) => error instanceof LibraryError && error.code === "LIBRARY_SECRET_REJECTED",
    );
    assert.throws(
      () => library.upsertTrack({
        title: "Leaky",
        source: { provider: "youtube", sourceId: "leak-2", refresh_token: "refresh-token-secret" },
      }),
      (error) => error.code === "LIBRARY_SECRET_REJECTED",
    );
    assert.throws(
      () => library.upsertTrack({
        title: "Leaky",
        source: { provider: "youtube", sourceId: "leak-3" },
        playlist: { provider: "youtube", playlistId: "PL1", clientSecret: "client-secret-value" },
      }),
      (error) => error.code === "LIBRARY_SECRET_REJECTED",
    );
    assert.throws(
      () => library.setSyncState("youtube.passphrase", "passphrase-secret"),
      (error) => error.code === "LIBRARY_SECRET_REJECTED",
    );
    assert.throws(
      () => library.setSyncState("youtube.session", {
        accessToken: "access-token-secret",
        refresh_token: "refresh-token-secret",
      }),
      (error) => error.code === "LIBRARY_SECRET_REJECTED",
    );
    assert.equal(library.trackCount(), 0);
  } finally {
    library.close();
  }
  try {
    const bytes = await readFile(filePath);
    const dump = bytes.toString("utf8");
    for (const secret of [
      "access-token-secret",
      "refresh-token-secret",
      "client-secret-value",
      "passphrase-secret",
    ]) {
      assert.equal(dump.includes(secret), false, `library file must not contain ${secret}`);
    }
    assert.equal(bytes.includes(Buffer.from("access-token-secret")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("closed or broken database reports coded errors, never fake success", async () => {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  library.upsertTrack({
    title: "Alive",
    source: { provider: "youtube", sourceId: "alive-1" },
  });
  library.close();

  assert.throws(
    () => library.upsertTrack({
      title: "Ghost",
      source: { provider: "youtube", sourceId: "ghost-1" },
    }),
    (error) => error instanceof LibraryError && error.code === "LIBRARY_CLOSED",
  );
  assert.throws(() => library.listRecent(), (error) => error.code === "LIBRARY_CLOSED");

  const broken = openLibrary(filePath);
  const saboteur = new DatabaseSync(filePath);
  try {
    saboteur.exec("DROP TABLE track_sources");
    assert.throws(
      () => broken.upsertTrack({
        title: "Doomed",
        source: { provider: "youtube", sourceId: "doomed-1" },
      }),
      (error) => error instanceof LibraryError && error.code === "LIBRARY_WRITE_FAILED",
    );
  } finally {
    saboteur.close();
    broken.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid input and init failures throw typed errors", async () => {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  try {
    assert.throws(
      () => library.upsertTrack({ source: { provider: "youtube", sourceId: "no-title" } }),
      (error) => error.code === "LIBRARY_INPUT_INVALID",
    );
    assert.throws(
      () => library.upsertTrack({ title: "No source" }),
      (error) => error.code === "LIBRARY_INPUT_INVALID",
    );
    assert.throws(
      () => library.addTag(999, "kpop"),
      (error) => error.code === "LIBRARY_INPUT_INVALID",
    );
    assert.throws(
      () => library.upsertTrack({
        title: "Bad tags",
        source: { provider: "youtube", sourceId: "bad-tags" },
        tags: ["ok", 123],
      }),
      (error) => error.code === "LIBRARY_INPUT_INVALID",
    );
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }

  assert.throws(
    () => new MusicLibrary("   "),
    (error) => error.code === "LIBRARY_PATH_REQUIRED",
  );
});

test("name-only playlists are not collapsed per provider", async () => {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  try {
    const kpop = library.upsertTrack({
      title: "Ditto",
      source: { provider: "youtube", sourceId: "kpop-1" },
      playlist: { provider: "youtube", name: "K-pop" },
    });
    const jpop = library.upsertTrack({
      title: "Idol",
      source: { provider: "youtube", sourceId: "jpop-1" },
      playlist: { provider: "youtube", name: "J-pop" },
    });
    assert.deepEqual(library.listTrackPlaylists(kpop.track.id), [
      { provider: "youtube", playlistId: null, name: "K-pop" },
    ]);
    assert.deepEqual(library.listTrackPlaylists(jpop.track.id), [
      { provider: "youtube", playlistId: null, name: "J-pop" },
    ]);

    library.upsertTrack({
      title: "OMG",
      source: { provider: "youtube", sourceId: "kpop-2" },
      playlist: { provider: "youtube", name: "K-pop" },
    });
    const kpopTrack2 = library.getTrackBySource("youtube", "kpop-2");
    assert.deepEqual(library.listTrackPlaylists(kpopTrack2.id), [
      { provider: "youtube", playlistId: null, name: "K-pop" },
    ]);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("importing the MCP server module does not open a library", async () => {
  const serverModule = await import("../src/server.js");
  assert.equal(typeof serverModule.createServer, "function");
  assert.equal(typeof serverModule.main, "function");
});

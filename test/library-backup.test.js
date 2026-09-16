import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { exportLibrary, restoreLibrary } from "../src/library-backup.js";
import { LibraryError, openLibrary } from "../src/library.js";

const PL_B = "PL_BACKUP000001";
const VID_1 = "V_BKUP00001";
const VID_2 = "V_BKUP00002";

async function tempLibrary() {
  const directory = await mkdtemp(path.join(tmpdir(), "music-library-backup-"));
  return { directory, filePath: path.join(directory, "library.sqlite") };
}

async function seededLibrary(t) {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  const saved = library.upsertTrack({
    title: "Backup Song",
    artist: "Backup Artist",
    genre: "pop",
    mood: "energetic",
    source: { provider: "youtube", sourceId: VID_1, url: `https://youtu.be/${VID_1}` },
    playlist: { provider: "youtube", playlistId: PL_B, name: "Backup PL" },
    tags: ["keep", "backup"],
  });
  library.upsertTrack({
    title: "Second Source Song",
    source: { provider: "youtube", sourceId: VID_2 },
  });
  library.setSyncState(`sync.${saved.track.id}`, {
    state: "synced",
    playlistId: PL_B,
    videoId: VID_1,
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  t.after(async () => {
    library.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { library, saved };
}

test("export produces deterministic versioned JSON with metadata and zero secrets", async (t) => {
  const { library } = await seededLibrary(t);
  // A credential-looking row smuggled straight into sync_state must be
  // excluded from the backup even though it bypassed setSyncState.
  library.db
    .prepare("INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)")
    .run("youtube.oauth.token", '{"accessToken":"ya29.secret","refreshToken":"1//x"}', "2026-01-01T00:00:00.000Z");

  const first = exportLibrary(library, { format: "json" });
  const second = exportLibrary(library, { format: "json" });
  const backup = JSON.parse(first);

  assert.equal(backup.format, "music-library-backup");
  assert.equal(backup.formatVersion, 1);
  assert.equal(backup.schemaVersion, 3);
  assert.equal(backup.appVersion, "0.2.0");
  assert.ok(backup.exportedAt);
  assert.equal(backup.counts.tracks, 2);
  assert.equal(backup.counts.sources, 2);

  // Deterministic modulo the timestamp.
  delete backup.exportedAt;
  const secondParsed = JSON.parse(second);
  delete secondParsed.exportedAt;
  assert.deepEqual(secondParsed, backup);

  const text = JSON.stringify(backup);
  assert.equal(text.includes("ya29.secret"), false);
  assert.equal(text.includes("refreshToken"), false);
  assert.equal(backup.excluded.secrets, 1);
});

test("round-trip: an empty library restores tracks, sources, tags, and decisions", async (t) => {
  const { library: source } = await seededLibrary(t);
  const backup = exportLibrary(source, { format: "json" });

  const { directory, filePath } = await tempLibrary();
  const target = openLibrary(filePath);
  t.after(async () => {
    target.close();
    await rm(directory, { recursive: true, force: true });
  });

  const preview = restoreLibrary(target, backup, { mode: "preview" });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.counts.insert, 2);
  assert.equal(target.trackCount(), 0); // preview writes nothing

  const applied = restoreLibrary(target, backup, { mode: "apply" });
  assert.equal(applied.mode, "apply");
  assert.equal(applied.counts.insert, 2);
  assert.equal(target.trackCount(), 2);

  const restored = target.getTrackBySource("youtube", VID_1);
  assert.equal(restored.canonicalTitle, "Backup Song");
  assert.equal(restored.artist, "Backup Artist");
  assert.equal(restored.genre, "pop");
  assert.equal(restored.mood, "energetic");
  assert.deepEqual(target.listTags(restored.id), ["backup", "keep"]);
  assert.deepEqual(
    target.listTrackPlaylists(restored.id).map((entry) => entry.playlistId),
    [PL_B],
  );
  assert.equal(
    JSON.parse(target.getSyncState(`sync.${restored.id}`)).state,
    "synced",
  );
  assert.ok(target.getTrackBySource("youtube", VID_2));
});

test("restoring the same backup twice is idempotent — no duplicates", async (t) => {
  const { library: source } = await seededLibrary(t);
  const backup = exportLibrary(source, { format: "json" });

  const { directory, filePath } = await tempLibrary();
  const target = openLibrary(filePath);
  t.after(async () => {
    target.close();
    await rm(directory, { recursive: true, force: true });
  });

  restoreLibrary(target, backup, { mode: "apply" });
  const again = restoreLibrary(target, backup, { mode: "apply" });
  assert.equal(again.counts.insert, 0);
  assert.equal(target.trackCount(), 2);
  assert.equal(target.getTrackBySource("youtube", VID_1).id, target.getTrackBySource("youtube", VID_1).id);
});

test("incompatible schema version fails safely without partial writes", async (t) => {
  const { library: source } = await seededLibrary(t);
  const backup = JSON.parse(exportLibrary(source, { format: "json" }));
  backup.schemaVersion = 99;

  const { directory, filePath } = await tempLibrary();
  const target = openLibrary(filePath);
  t.after(async () => {
    target.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.throws(
    () => restoreLibrary(target, backup, { mode: "apply" }),
    (error) => error instanceof LibraryError,
  );
  assert.equal(target.trackCount(), 0);
});

test("corrupt backups are rejected before any write", async (t) => {
  const { library: source } = await seededLibrary(t);
  const { directory, filePath } = await tempLibrary();
  const target = openLibrary(filePath);
  t.after(async () => {
    target.close();
    await rm(directory, { recursive: true, force: true });
  });

  for (const bad of [
    "not json at all",
    JSON.stringify({ format: "other" }),
    JSON.stringify({ format: "music-library-backup", formatVersion: 7, schemaVersion: 3 }),
    JSON.stringify({ format: "music-library-backup", formatVersion: 1, schemaVersion: 3, data: { tracks: "oops" } }),
    exportLibrary(source, { format: "json" }).slice(0, 40),
  ]) {
    assert.throws(() => restoreLibrary(target, bad, { mode: "apply" }), LibraryError);
  }
  assert.equal(target.trackCount(), 0);
});

test("restore never triggers provider writes and marks sync state as a snapshot", async (t) => {
  const { library: source } = await seededLibrary(t);
  const backup = JSON.parse(exportLibrary(source, { format: "json" }));
  assert.ok(backup.meta.syncStateIsSnapshot);

  const { directory, filePath } = await tempLibrary();
  const target = openLibrary(filePath);
  t.after(async () => {
    target.close();
    await rm(directory, { recursive: true, force: true });
  });
  const result = restoreLibrary(target, backup, { mode: "apply" });
  assert.equal(result.providerWrites, 0);
  assert.match(result.nextStep, /sync_youtube/);
});

test("restore preserves manual identity decisions on freshly inserted tracks", async (t) => {
  const { library: source, saved } = await seededLibrary(t);
  const second = source.getTrackBySource("youtube", VID_2);
  source.db
    .prepare(
      `INSERT INTO identity_candidates (track_id, candidate_track_id, confidence, reason, decided_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(saved.track.id, second.id, 0.62, "possible_duplicate", "2026-01-01T00:00:00.000Z");
  const backup = exportLibrary(source, { format: "json" });

  const { directory, filePath } = await tempLibrary();
  const target = openLibrary(filePath);
  t.after(async () => {
    target.close();
    await rm(directory, { recursive: true, force: true });
  });

  const preview = restoreLibrary(target, backup, { mode: "preview" });
  assert.equal(preview.counts.unsupported, 0, "candidates between restored tracks must not be unsupported");

  restoreLibrary(target, backup, { mode: "apply" });
  const restoredFirst = target.getTrackBySource("youtube", VID_1);
  const restoredSecond = target.getTrackBySource("youtube", VID_2);
  const row = target.db
    .prepare(
      `SELECT confidence, reason FROM identity_candidates
       WHERE track_id = ? AND candidate_track_id = ?`,
    )
    .get(restoredFirst.id, restoredSecond.id);
  assert.ok(row, "identity_candidates row must survive a restore onto an empty library");
  assert.equal(row.confidence, 0.62);
  assert.equal(row.reason, "possible_duplicate");
});

test("CSV export is a readable analysis format, not a lossless backup", async (t) => {
  const { library } = await seededLibrary(t);
  const csv = exportLibrary(library, { format: "csv" });
  const [header, ...rows] = csv.trim().split("\n");
  assert.match(header, /canonical_title/);
  assert.match(header, /youtube_ids/);
  assert.equal(rows.length, 2);
  const row = rows.find((line) => line.includes("Backup Song"));
  assert.ok(row.includes(VID_1));
  assert.ok(row.includes("backup"));
});

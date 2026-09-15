import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const SECRET_KEY_PATTERN = /passphrase|secret|token|api[_-]?key|private[_-]?key|credential/i;

const TRACK_COLUMNS = Object.freeze({
  canonicalTitle: "canonical_title",
  artist: "artist",
  language: "language",
  genre: "genre",
  mood: "mood",
  activity: "activity",
  energy: "energy",
  era: "era",
});

const MIGRATIONS = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS tracks (
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
      )`,
      `CREATE TABLE IF NOT EXISTS track_sources (
        id INTEGER PRIMARY KEY,
        track_id INTEGER NOT NULL REFERENCES tracks(id),
        provider TEXT NOT NULL,
        source_id TEXT NOT NULL,
        url TEXT,
        version_type TEXT,
        UNIQUE(provider, source_id)
      )`,
      `CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY,
        provider TEXT NOT NULL,
        playlist_id TEXT,
        name TEXT,
        UNIQUE(provider, playlist_id)
      )`,
      `CREATE TABLE IF NOT EXISTS track_playlists (
        track_id INTEGER NOT NULL REFERENCES tracks(id),
        playlist_id INTEGER NOT NULL REFERENCES playlists(id),
        added_at TEXT NOT NULL,
        PRIMARY KEY (track_id, playlist_id)
      )`,
      `CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE
      )`,
      `CREATE TABLE IF NOT EXISTS track_tags (
        track_id INTEGER NOT NULL REFERENCES tracks(id),
        tag_id INTEGER NOT NULL REFERENCES tags(id),
        PRIMARY KEY (track_id, tag_id)
      )`,
      `CREATE TABLE IF NOT EXISTS aliases (
        id INTEGER PRIMARY KEY,
        kind TEXT NOT NULL,
        value TEXT NOT NULL,
        track_id INTEGER NOT NULL REFERENCES tracks(id),
        UNIQUE(kind, value, track_id)
      )`,
      `CREATE TABLE IF NOT EXISTS sync_state (
        key TEXT PRIMARY KEY,
        value TEXT,
        updated_at TEXT NOT NULL
      )`,
    ],
  },
];

export class LibraryError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "LibraryError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

export function libraryFilePath(env = process.env) {
  if (env.MUSIC_LIBRARY_FILE?.trim()) return path.resolve(env.MUSIC_LIBRARY_FILE.trim());

  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir();
  const base = env.APPDATA?.trim()
    ? env.APPDATA.trim()
    : env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return path.join(base, "music-playlist-organizer", "library.sqlite");
}

export function openLibrary(envOrPath = process.env) {
  const filePath = typeof envOrPath === "string" ? envOrPath : libraryFilePath(envOrPath);
  return new MusicLibrary(filePath);
}

function trackRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    canonicalTitle: row.canonical_title,
    artist: row.artist,
    language: row.language,
    genre: row.genre,
    mood: row.mood,
    activity: row.activity,
    energy: row.energy,
    era: row.era,
    savedAt: row.saved_at,
    updatedAt: row.updated_at,
  };
}

function sourceRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    trackId: row.track_id,
    provider: row.provider,
    sourceId: row.source_id,
    url: row.url,
    versionType: row.version_type,
  };
}

function assertNoSecretKeys(value) {
  if (Array.isArray(value)) {
    for (const item of value) assertNoSecretKeys(item);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, item] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new LibraryError(
        "LIBRARY_SECRET_REJECTED",
        `Refusing to store the secret-looking field "${key}" in the music library. Secrets belong in the credential store.`,
      );
    }
    assertNoSecretKeys(item);
  }
}

function optionalText(value, name) {
  if (value === undefined || value === null) return value;
  if (typeof value !== "string") {
    throw new LibraryError("LIBRARY_INPUT_INVALID", `Field "${name}" must be a string.`);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeTrackInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "A track input object is required.");
  }
  assertNoSecretKeys(input);

  const fields = {};
  if (input.title !== undefined) {
    const title = optionalText(input.title, "title");
    if (!title) throw new LibraryError("LIBRARY_INPUT_INVALID", "A non-empty title is required.");
    fields.canonicalTitle = title;
  }
  for (const field of Object.keys(TRACK_COLUMNS)) {
    if (field === "canonicalTitle") continue;
    if (input[field] !== undefined) fields[field] = optionalText(input[field], field);
  }

  if (!input.source || typeof input.source !== "object") {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "A source object is required so the track can be deduplicated.");
  }
  const provider = optionalText(input.source.provider, "source.provider");
  const sourceId = optionalText(input.source.sourceId, "source.sourceId");
  if (!provider || !sourceId) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "source.provider and source.sourceId are required.");
  }
  const source = {
    provider,
    sourceId,
    url: optionalText(input.source.url, "source.url"),
    versionType: optionalText(input.source.versionType, "source.versionType"),
  };

  let tags = [];
  if (input.tags !== undefined) {
    if (!Array.isArray(input.tags)) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "tags must be an array of strings.");
    }
    tags = input.tags.map((tag, index) => {
      if (typeof tag !== "string") {
        throw new LibraryError("LIBRARY_INPUT_INVALID", `tags[${index}] must be a string.`);
      }
      return tag.trim();
    }).filter(Boolean);
  }

  let playlist = null;
  if (input.playlist !== undefined && input.playlist !== null) {
    if (typeof input.playlist !== "object") {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "playlist must be an object.");
    }
    const playlistProvider = optionalText(input.playlist.provider, "playlist.provider");
    if (!playlistProvider) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "playlist.provider is required.");
    }
    playlist = {
      provider: playlistProvider,
      playlistId: optionalText(input.playlist.playlistId, "playlist.playlistId"),
      name: optionalText(input.playlist.name, "playlist.name"),
    };
  }

  return { fields, source, tags, playlist };
}

function writeFailed(error) {
  if (error instanceof LibraryError) throw error;
  throw new LibraryError("LIBRARY_WRITE_FAILED", "The music library write failed.", { cause: error });
}

function readFailed(error) {
  if (error instanceof LibraryError) throw error;
  throw new LibraryError("LIBRARY_READ_FAILED", "The music library read failed.", { cause: error });
}

export class MusicLibrary {
  constructor(filePath) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new LibraryError("LIBRARY_PATH_REQUIRED", "A library database file path is required.");
    }
    this.filePath = path.resolve(filePath);
    this.closed = false;
    this.db = null;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.db = new DatabaseSync(this.filePath, { timeout: 5000 });
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA foreign_keys = ON");
      this.initialize();
    } catch (error) {
      const db = this.db;
      this.db = null;
      if (db) {
        try {
          db.close();
        } catch (closeError) {
          this.closed = true;
          throw new LibraryError(
            "LIBRARY_INIT_FAILED",
            "Unable to open the local music library database.",
            { cause: error },
          );
        }
      }
      this.closed = true;
      if (error instanceof LibraryError) throw error;
      throw new LibraryError(
        "LIBRARY_INIT_FAILED",
        "Unable to open the local music library database.",
        { cause: error },
      );
    }
  }

  initialize() {
    this.assertOpen();
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )`);
    const row = this.db
      .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
      .get();
    const current = row.version;
    for (const migration of MIGRATIONS) {
      if (migration.version <= current) continue;
      this.db.exec("BEGIN IMMEDIATE");
      try {
        for (const statement of migration.statements) this.db.exec(statement);
        this.db
          .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
          .run(migration.version, new Date().toISOString());
        this.db.exec("COMMIT");
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch {}
        throw new LibraryError(
          "LIBRARY_MIGRATION_FAILED",
          `Unable to migrate the music library to schema version ${migration.version}.`,
          { cause: error },
        );
      }
    }
    return this;
  }

  assertOpen() {
    if (this.closed || !this.db) {
      throw new LibraryError("LIBRARY_CLOSED", "The music library database is closed.");
    }
  }

  schemaVersion() {
    this.assertOpen();
    try {
      const row = this.db
        .prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations")
        .get();
      return row.version;
    } catch (error) {
      readFailed(error);
    }
  }

  upsertTrack(input) {
    this.assertOpen();
    const normalized = normalizeTrackInput(input);
    const now = new Date().toISOString();

    this.db.exec("BEGIN IMMEDIATE");
    let trackId;
    let created;
    try {
      const existingSource = this.db
        .prepare("SELECT id, track_id FROM track_sources WHERE provider = ? AND source_id = ?")
        .get(normalized.source.provider, normalized.source.sourceId);

      if (existingSource) {
        trackId = existingSource.track_id;
        created = false;
        const assignments = ["updated_at = ?"];
        const params = [now];
        for (const [field, column] of Object.entries(TRACK_COLUMNS)) {
          if (normalized.fields[field] === undefined) continue;
          assignments.push(`${column} = ?`);
          params.push(normalized.fields[field]);
        }
        params.push(trackId);
        this.db.prepare(`UPDATE tracks SET ${assignments.join(", ")} WHERE id = ?`).run(...params);

        const sourceUpdates = [];
        const sourceParams = [];
        if (normalized.source.url !== undefined) {
          sourceUpdates.push("url = ?");
          sourceParams.push(normalized.source.url);
        }
        if (normalized.source.versionType !== undefined) {
          sourceUpdates.push("version_type = ?");
          sourceParams.push(normalized.source.versionType);
        }
        if (sourceUpdates.length) {
          sourceParams.push(existingSource.id);
          this.db
            .prepare(`UPDATE track_sources SET ${sourceUpdates.join(", ")} WHERE id = ?`)
            .run(...sourceParams);
        }
      } else {
        if (!normalized.fields.canonicalTitle) {
          throw new LibraryError("LIBRARY_INPUT_INVALID", "A non-empty title is required.");
        }
        const result = this.db
          .prepare(
            `INSERT INTO tracks
              (canonical_title, artist, language, genre, mood, activity, energy, era, saved_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            normalized.fields.canonicalTitle,
            normalized.fields.artist ?? null,
            normalized.fields.language ?? null,
            normalized.fields.genre ?? null,
            normalized.fields.mood ?? null,
            normalized.fields.activity ?? null,
            normalized.fields.energy ?? null,
            normalized.fields.era ?? null,
            now,
            now,
          );
        trackId = Number(result.lastInsertRowid);
        this.db
          .prepare(
            "INSERT INTO track_sources (track_id, provider, source_id, url, version_type) VALUES (?, ?, ?, ?, ?)",
          )
          .run(
            trackId,
            normalized.source.provider,
            normalized.source.sourceId,
            normalized.source.url ?? null,
            normalized.source.versionType ?? null,
          );
        created = true;
      }

      for (const tag of normalized.tags) this.linkTag(trackId, tag);
      if (normalized.playlist) this.linkPlaylist(trackId, normalized.playlist, now);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      writeFailed(error);
    }

    return {
      track: this.getTrackById(trackId),
      created,
      source: this.source(normalized.source.provider, normalized.source.sourceId),
      writeState: "SAVED",
    };
  }

  linkTag(trackId, name) {
    this.db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(name);
    const tag = this.db.prepare("SELECT id FROM tags WHERE name = ?").get(name);
    this.db
      .prepare("INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?, ?)")
      .run(trackId, tag.id);
  }

  linkPlaylist(trackId, playlist, now) {
    if (!playlist.playlistId && !playlist.name) {
      throw new LibraryError(
        "LIBRARY_INPUT_INVALID",
        "playlist.playlistId or playlist.name is required.",
      );
    }

    const row = playlist.playlistId
      ? this.db
        .prepare("SELECT id, name FROM playlists WHERE provider = ? AND playlist_id = ?")
        .get(playlist.provider, playlist.playlistId)
      : this.db
        .prepare("SELECT id, name FROM playlists WHERE provider = ? AND playlist_id IS NULL AND name = ?")
        .get(playlist.provider, playlist.name);

    let playlistRowId;
    if (row) {
      playlistRowId = row.id;
      if (playlist.name && playlist.name !== row.name) {
        this.db.prepare("UPDATE playlists SET name = ? WHERE id = ?").run(playlist.name, row.id);
      }
    } else {
      const result = this.db
        .prepare("INSERT INTO playlists (provider, playlist_id, name) VALUES (?, ?, ?)")
        .run(playlist.provider, playlist.playlistId ?? null, playlist.name ?? null);
      playlistRowId = Number(result.lastInsertRowid);
    }
    this.db
      .prepare("INSERT OR IGNORE INTO track_playlists (track_id, playlist_id, added_at) VALUES (?, ?, ?)")
      .run(trackId, playlistRowId, now);
  }

  listTrackPlaylists(trackId) {
    this.assertOpen();
    try {
      return this.db
        .prepare(
          `SELECT p.provider, p.playlist_id AS playlistId, p.name
           FROM playlists p
           JOIN track_playlists tp ON tp.playlist_id = p.id
           WHERE tp.track_id = ?
           ORDER BY p.name, p.playlist_id, p.id`,
        )
        .all(trackId)
        .map((row) => ({
          provider: row.provider,
          playlistId: row.playlistId ?? null,
          name: row.name ?? null,
        }));
    } catch (error) {
      readFailed(error);
    }
  }

  source(provider, sourceId) {
    this.assertOpen();
    try {
      return sourceRow(
        this.db
          .prepare("SELECT * FROM track_sources WHERE provider = ? AND source_id = ?")
          .get(provider, sourceId),
      );
    } catch (error) {
      readFailed(error);
    }
  }

  getTrackById(id) {
    this.assertOpen();
    try {
      return trackRow(this.db.prepare("SELECT * FROM tracks WHERE id = ?").get(id));
    } catch (error) {
      readFailed(error);
    }
  }

  getTrackBySource(provider, sourceId) {
    this.assertOpen();
    try {
      return trackRow(
        this.db
          .prepare(
            `SELECT t.* FROM tracks t
             JOIN track_sources s ON s.track_id = t.id
             WHERE s.provider = ? AND s.source_id = ?`,
          )
          .get(provider, sourceId),
      );
    } catch (error) {
      readFailed(error);
    }
  }

  listRecent(limit = 20) {
    this.assertOpen();
    const capped = Math.min(Math.max(Math.trunc(Number(limit)) || 20, 1), 500);
    try {
      return this.db
        .prepare("SELECT * FROM tracks ORDER BY saved_at DESC, id DESC LIMIT ?")
        .all(capped)
        .map(trackRow);
    } catch (error) {
      readFailed(error);
    }
  }

  addTag(trackId, tag) {
    this.assertOpen();
    if (typeof tag !== "string" || !tag.trim()) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "A non-empty tag is required.");
    }
    if (!this.getTrackById(trackId)) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", `Track ${trackId} does not exist.`);
    }
    try {
      this.linkTag(trackId, tag.trim());
    } catch (error) {
      writeFailed(error);
    }
    return this.listTags(trackId);
  }

  listTags(trackId) {
    this.assertOpen();
    try {
      return this.db
        .prepare(
          `SELECT t.name FROM tags t
           JOIN track_tags tt ON tt.tag_id = t.id
           WHERE tt.track_id = ?
           ORDER BY t.name`,
        )
        .all(trackId)
        .map((row) => row.name);
    } catch (error) {
      readFailed(error);
    }
  }

  setSyncState(key, value) {
    this.assertOpen();
    if (typeof key !== "string" || !key.trim()) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "A non-empty sync_state key is required.");
    }
    if (SECRET_KEY_PATTERN.test(key)) {
      throw new LibraryError(
        "LIBRARY_SECRET_REJECTED",
        `Refusing to store the secret-looking sync_state key "${key}". Secrets belong in the credential store.`,
      );
    }
    if (value && typeof value === "object") assertNoSecretKeys(value);
    let stored;
    try {
      stored = value === undefined || value === null
        ? null
        : typeof value === "string"
          ? value
          : JSON.stringify(value);
      this.db
        .prepare(
          `INSERT INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(key.trim(), stored, new Date().toISOString());
    } catch (error) {
      writeFailed(error);
    }
    return { key: key.trim(), value: stored };
  }

  getSyncState(key) {
    this.assertOpen();
    if (typeof key !== "string" || !key.trim()) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "A non-empty sync_state key is required.");
    }
    try {
      const row = this.db.prepare("SELECT value FROM sync_state WHERE key = ?").get(key.trim());
      return row ? row.value : null;
    } catch (error) {
      readFailed(error);
    }
  }

  trackCount() {
    this.assertOpen();
    try {
      return this.db.prepare("SELECT COUNT(*) AS count FROM tracks").get().count;
    } catch (error) {
      readFailed(error);
    }
  }

  status() {
    return {
      filePath: this.filePath,
      schemaVersion: this.schemaVersion(),
      trackCount: this.trackCount(),
    };
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      try { this.db?.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch {}
      this.db?.close();
    } catch (error) {
      throw new LibraryError(
        "LIBRARY_CLOSE_FAILED",
        "Unable to close the music library database cleanly.",
        { cause: error },
      );
    } finally {
      this.db = null;
    }
  }
}

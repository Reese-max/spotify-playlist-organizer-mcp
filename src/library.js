import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  canonicalizeSource,
  normalizeText,
  SOURCE_TYPES,
  tokenContainment,
  tokenSimilarity,
} from "./canonical.js";
import { canonicalValue } from "./taxonomy.js";

const SECRET_KEY_PATTERN = /passphrase|secret|token|api[_-]?key|private[_-]?key|credential/i;

const POSSIBLE_MATCH_THRESHOLD = 0.4;

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
  {
    version: 2,
    statements: [
      "ALTER TABLE tracks ADD COLUMN canonical_key TEXT",
      "ALTER TABLE tracks ADD COLUMN normalized_title TEXT",
      "ALTER TABLE tracks ADD COLUMN normalized_artist TEXT",
      "ALTER TABLE tracks ADD COLUMN identity_locked INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE tracks ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE track_sources ADD COLUMN source_type TEXT",
      "ALTER TABLE track_sources ADD COLUMN confidence REAL",
      "ALTER TABLE track_sources ADD COLUMN provenance TEXT",
      "CREATE INDEX IF NOT EXISTS idx_tracks_canonical_key ON tracks(canonical_key)",
      "CREATE INDEX IF NOT EXISTS idx_tracks_normalized_title ON tracks(normalized_title)",
      "CREATE INDEX IF NOT EXISTS idx_tracks_normalized_artist ON tracks(normalized_artist)",
      `CREATE TABLE IF NOT EXISTS identity_candidates (
        track_id INTEGER NOT NULL REFERENCES tracks(id),
        candidate_track_id INTEGER NOT NULL REFERENCES tracks(id),
        confidence REAL NOT NULL,
        reason TEXT,
        decided_at TEXT NOT NULL,
        PRIMARY KEY (track_id, candidate_track_id)
      )`,
    ],
  },
  {
    version: 3,
    statements: [
      "ALTER TABLE track_sources ADD COLUMN status TEXT",
    ],
  },
];

export const DEDUPE_LEVELS = Object.freeze([
  "EXACT_SOURCE_DUPLICATE",
  "SAME_CANONICAL_TRACK",
  "POSSIBLE_MATCH",
  "DISTINCT_TRACK",
]);

const SOURCE_TYPE_SET = new Set(SOURCE_TYPES);

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
    canonicalKey: row.canonical_key ?? null,
    normalizedTitle: row.normalized_title ?? null,
    normalizedArtist: row.normalized_artist ?? null,
    identityLocked: Boolean(row.identity_locked),
    needsReview: Boolean(row.needs_review),
  };
}

function sourceRow(row) {
  if (!row) return null;
  let provenance = row.provenance ?? null;
  if (typeof provenance === "string") {
    try {
      provenance = JSON.parse(provenance);
    } catch {}
  }
  return {
    id: row.id,
    trackId: row.track_id,
    provider: row.provider,
    sourceId: row.source_id,
    url: row.url,
    versionType: row.version_type,
    sourceType: row.source_type ?? "unknown",
    status: row.status ?? "ok",
    confidence: row.confidence ?? null,
    provenance,
  };
}

const SECRETISH_KEY = /token|secret|passphrase|password|credential|oauth|api[-_]?key|authorization/i;

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
    sourceType: optionalText(input.source.sourceType, "source.sourceType"),
    channelTitle: optionalText(input.source.channelTitle, "source.channelTitle"),
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

const MAX_QUERY_LIMIT = 100;

// Dimension filters that map 1:1 onto `tracks` columns. Anything outside this
// whitelist must never reach the SQL string.
const SEARCH_DIMENSIONS = Object.freeze(["genre", "mood", "language", "activity"]);

const UNSYNCED_REASONS = Object.freeze([
  "not_synced",
  "identity_conflict",
  "provider_unavailable",
]);

function boundedPage({ limit, offset } = {}, defaultLimit = 20) {
  const boundedLimit = Math.min(Math.max(Math.trunc(Number(limit)) || defaultLimit, 1), MAX_QUERY_LIMIT);
  const boundedOffset = Math.max(Math.trunc(Number(offset)) || 0, 0);
  return { limit: boundedLimit, offset: boundedOffset };
}

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (match) => "\\" + match);
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
    this.backfillIdentities();
    return this;
  }

  backfillIdentities() {
    const tracks = this.db
      .prepare("SELECT id, canonical_title, artist FROM tracks WHERE canonical_key IS NULL")
      .all();
    const update = this.db.prepare(
      `UPDATE tracks SET canonical_key = ?, normalized_title = ?, normalized_artist = ?
       WHERE id = ?`,
    );
    for (const row of tracks) {
      const identity = canonicalizeSource({ title: row.canonical_title, artist: row.artist });
      update.run(identity.canonicalKey, identity.normalizedTitle, identity.normalizedArtist, row.id);
    }

    const sources = this.db
      .prepare("SELECT id, version_type FROM track_sources WHERE source_type IS NULL")
      .all();
    const updateSource = this.db.prepare(
      "UPDATE track_sources SET source_type = ?, confidence = ?, provenance = ? WHERE id = ?",
    );
    for (const row of sources) {
      const hinted = typeof row.version_type === "string"
        ? normalizeText(row.version_type).replace(/\s+/g, "_")
        : "";
      const sourceType = SOURCE_TYPE_SET.has(hinted) ? hinted : "unknown";
      updateSource.run(
        sourceType,
        1,
        JSON.stringify({ matchedBy: "backfill_v1" }),
        row.id,
      );
    }

    const collisions = this.db
      .prepare(
        `SELECT canonical_key FROM tracks
         WHERE canonical_key IS NOT NULL
         GROUP BY canonical_key HAVING COUNT(*) > 1`,
      )
      .all();
    const now = new Date().toISOString();
    for (const { canonical_key: key } of collisions) {
      const rows = this.db
        .prepare("SELECT id FROM tracks WHERE canonical_key = ? ORDER BY id")
        .all(key);
      const keeper = rows[0].id;
      for (const { id } of rows.slice(1)) {
        this.db
          .prepare(
            `INSERT OR IGNORE INTO identity_candidates
              (track_id, candidate_track_id, confidence, reason, decided_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(id, keeper, 1, "canonical_key_collision", now);
      }
    }
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
    let identity;
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
          if (field === "canonicalTitle" || field === "artist") continue;
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
        if (normalized.source.sourceType !== undefined) {
          sourceUpdates.push("source_type = ?");
          sourceParams.push(normalized.source.sourceType);
        }
        if (sourceUpdates.length) {
          sourceParams.push(existingSource.id);
          this.db
            .prepare(`UPDATE track_sources SET ${sourceUpdates.join(", ")} WHERE id = ?`)
            .run(...sourceParams);
        }
        identity = {
          state: "existing",
          level: "EXACT_SOURCE_DUPLICATE",
          canonicalKey: this.ensureTrackIdentity(trackId),
          confidence: 1,
          matchedTrackId: trackId,
          candidates: [],
        };
      } else {
        if (!normalized.fields.canonicalTitle) {
          throw new LibraryError("LIBRARY_INPUT_INVALID", "A non-empty title is required.");
        }
        const canonical = canonicalizeSource({
          title: normalized.fields.canonicalTitle,
          artist: normalized.fields.artist,
          channelTitle: normalized.source.channelTitle,
          versionType: normalized.source.versionType,
          sourceType: normalized.source.sourceType,
        });
        const decision = this.evaluateIdentity(canonical);

        if (decision.action === "attach") {
          trackId = decision.target.id;
          created = false;
          this.db
            .prepare(
              `UPDATE tracks SET updated_at = ?,
                 artist = COALESCE(artist, ?),
                 language = COALESCE(language, ?),
                 genre = COALESCE(genre, ?),
                 mood = COALESCE(mood, ?),
                 activity = COALESCE(activity, ?),
                 energy = COALESCE(energy, ?),
                 era = COALESCE(era, ?)
               WHERE id = ?`,
            )
            .run(
              now,
              normalized.fields.artist ?? null,
              normalized.fields.language ?? null,
              normalized.fields.genre ?? null,
              normalized.fields.mood ?? null,
              normalized.fields.activity ?? null,
              normalized.fields.energy ?? null,
              normalized.fields.era ?? null,
              trackId,
            );
          this.insertSource(trackId, normalized, canonical, decision, now);
          this.recordAliases(trackId, normalized, canonical);
          for (const collision of decision.collisions) {
            this.recordCandidate(trackId, collision.id, 1, "canonical_key_collision", now);
            this.db.prepare("UPDATE tracks SET needs_review = 1 WHERE id = ?").run(trackId);
          }
          identity = {
            state: "same_canonical",
            level: "SAME_CANONICAL_TRACK",
            canonicalKey: canonical.canonicalKey,
            confidence: decision.confidence,
            matchedTrackId: trackId,
            matchedBy: decision.matchedBy,
            candidates: [],
          };
        } else {
          const needsReview = decision.action === "review" ? 1 : 0;
          const result = this.db
            .prepare(
              `INSERT INTO tracks
                (canonical_title, artist, language, genre, mood, activity, energy, era,
                 saved_at, updated_at, canonical_key, normalized_title, normalized_artist,
                 identity_locked, needs_review)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
            )
            .run(
              normalized.fields.canonicalTitle,
              normalized.fields.artist ?? canonical.artist ?? null,
              normalized.fields.language ?? null,
              normalized.fields.genre ?? null,
              normalized.fields.mood ?? null,
              normalized.fields.activity ?? null,
              normalized.fields.energy ?? null,
              normalized.fields.era ?? null,
              now,
              now,
              canonical.canonicalKey,
              canonical.normalizedTitle,
              canonical.normalizedArtist || null,
              needsReview,
            );
          trackId = Number(result.lastInsertRowid);
          created = true;
          this.insertSource(trackId, normalized, canonical, { matchedBy: "new", confidence: 1 }, now);
          this.recordAliases(trackId, normalized, canonical);
          for (const candidate of decision.candidates) {
            this.recordCandidate(trackId, candidate.trackId, candidate.confidence, candidate.reason, now);
          }
          identity = {
            state: needsReview ? "possible_match" : "created",
            level: needsReview ? "POSSIBLE_MATCH" : "DISTINCT_TRACK",
            canonicalKey: canonical.canonicalKey,
            confidence: needsReview ? decision.candidates[0].confidence : 1,
            matchedTrackId: trackId,
            candidates: decision.candidates,
          };
        }
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
      identity,
    };
  }

  evaluateIdentity(canonical) {
    const exact = this.db
      .prepare(
        `SELECT id, identity_locked FROM tracks
         WHERE canonical_key = ? ORDER BY id`,
      )
      .all(canonical.canonicalKey);
    const unlocked = exact.filter((row) => !row.identity_locked);
    if (unlocked.length) {
      return {
        action: "attach",
        target: unlocked[0],
        matchedBy: "canonical_key",
        confidence: 1,
        collisions: exact.filter((row) => row.id !== unlocked[0].id),
        candidates: [],
      };
    }
    if (exact.length) {
      return {
        action: "review",
        matchedBy: "canonical_key",
        candidates: exact.map((row) => ({
          trackId: row.id,
          confidence: 1,
          reason: "identity_locked",
        })),
      };
    }

    const aliasRows = this.db
      .prepare(
        `SELECT t.id, t.identity_locked FROM aliases a
         JOIN tracks t ON t.id = a.track_id
         WHERE a.kind = 'canonical_key' AND a.value = ?
         ORDER BY t.id`,
      )
      .all(canonical.canonicalKey);
    const unlockedAliases = aliasRows.filter((row) => !row.identity_locked);
    if (unlockedAliases.length) {
      return {
        action: "attach",
        target: unlockedAliases[0],
        matchedBy: "canonical_alias",
        confidence: 1,
        collisions: unlockedAliases.filter((row) => row.id !== unlockedAliases[0].id),
        candidates: [],
      };
    }
    if (aliasRows.length) {
      return {
        action: "review",
        matchedBy: "canonical_alias",
        candidates: aliasRows.map((row) => ({
          trackId: row.id,
          confidence: 1,
          reason: "identity_locked",
        })),
      };
    }

    const candidates = this.fuzzyCandidates(canonical);
    if (candidates.length) return { action: "review", matchedBy: "fuzzy", candidates };
    return { action: "create", matchedBy: "none", candidates: [] };
  }

  fuzzyCandidates(canonical) {
    const rows = this.db
      .prepare(
        `SELECT id, normalized_title, normalized_artist FROM tracks
         WHERE (normalized_title = ? AND normalized_title != '')
            OR (normalized_artist != '' AND normalized_artist = ?)
         LIMIT 500`,
      )
      .all(canonical.normalizedTitle, canonical.normalizedArtist || "");
    const candidates = [];
    for (const row of rows) {
      let confidence = 0;
      let reason = null;
      if (row.normalized_title && row.normalized_title === canonical.normalizedTitle) {
        if ((row.normalized_artist || "") === canonical.normalizedArtist) {
          confidence = 0.8;
          reason = "same_song_different_version";
        } else if (!row.normalized_artist || !canonical.normalizedArtist) {
          confidence = 0.6;
          reason = "same_title_partial_artist";
        } else if (tokenContainment(row.normalized_artist, canonical.normalizedArtist)) {
          confidence = 0.55;
          reason = "same_title_related_artist";
        } else {
          confidence = 0.45;
          reason = "same_title_different_artist";
        }
      } else if (row.normalized_artist && row.normalized_artist === canonical.normalizedArtist) {
        if (tokenContainment(row.normalized_title, canonical.normalizedTitle)) {
          confidence = 0.5;
          reason = "similar_title";
        } else if (tokenSimilarity(row.normalized_title, canonical.normalizedTitle) >= 0.5) {
          confidence = 0.4;
          reason = "similar_title";
        }
      }
      if (confidence >= POSSIBLE_MATCH_THRESHOLD) {
        candidates.push({ trackId: row.id, confidence, reason });
      }
    }
    candidates.sort((a, b) => b.confidence - a.confidence || a.trackId - b.trackId);
    return candidates.slice(0, 20);
  }

  ensureTrackIdentity(trackId) {
    const row = this.db
      .prepare("SELECT canonical_title, artist, canonical_key FROM tracks WHERE id = ?")
      .get(trackId);
    if (!row) return null;
    if (row.canonical_key) return row.canonical_key;
    const canonical = canonicalizeSource({ title: row.canonical_title, artist: row.artist });
    this.db
      .prepare(
        `UPDATE tracks SET canonical_key = ?, normalized_title = ?, normalized_artist = ?
         WHERE id = ?`,
      )
      .run(canonical.canonicalKey, canonical.normalizedTitle, canonical.normalizedArtist, trackId);
    return canonical.canonicalKey;
  }

  insertSource(trackId, normalized, canonical, decision, now) {
    this.db
      .prepare(
        `INSERT INTO track_sources
          (track_id, provider, source_id, url, version_type, source_type, confidence, provenance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        trackId,
        normalized.source.provider,
        normalized.source.sourceId,
        normalized.source.url ?? null,
        normalized.source.versionType ?? null,
        canonical?.sourceType ?? "unknown",
        decision.confidence ?? null,
        JSON.stringify({
          matchedBy: decision.matchedBy ?? "new",
          version: canonical?.version || null,
          features: canonical?.features ?? [],
          packaging: canonical?.packaging ?? [],
          channelTitle: normalized.source.channelTitle ?? null,
          decidedAt: now,
        }),
      );
  }

  recordAliases(trackId, normalized, canonical) {
    const statement = this.db.prepare(
      "INSERT OR IGNORE INTO aliases (kind, value, track_id) VALUES (?, ?, ?)",
    );
    const rawTitle = normalizeText(normalized.fields.canonicalTitle);
    if (rawTitle) statement.run("title", rawTitle, trackId);
    const rawArtist = normalizeText(normalized.fields.artist ?? canonical?.artist ?? "");
    if (rawArtist) statement.run("artist", rawArtist, trackId);
    for (const feature of canonical?.features ?? []) {
      statement.run("feature", feature, trackId);
    }
  }

  recordCandidate(trackId, candidateTrackId, confidence, reason, now) {
    if (trackId === candidateTrackId) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO identity_candidates
          (track_id, candidate_track_id, confidence, reason, decided_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(trackId, candidateTrackId, confidence, reason, now ?? new Date().toISOString());
  }

  previewIdentity(input) {
    this.assertOpen();
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "A track input object is required.");
    }
    assertNoSecretKeys(input);
    const title = optionalText(input.title, "title");
    if (!title) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "A non-empty title is required.");
    }
    const artist = optionalText(input.artist, "artist");
    const source = input.source && typeof input.source === "object" ? input.source : {};
    const canonical = canonicalizeSource({
      title,
      artist,
      channelTitle: optionalText(source.channelTitle, "source.channelTitle"),
      versionType: optionalText(source.versionType, "source.versionType"),
      sourceType: optionalText(source.sourceType, "source.sourceType"),
    });
    try {
      const provider = optionalText(source.provider, "source.provider");
      const sourceId = optionalText(source.sourceId, "source.sourceId");
      if (provider && sourceId) {
        const existing = this.db
          .prepare("SELECT track_id FROM track_sources WHERE provider = ? AND source_id = ?")
          .get(provider, sourceId);
        if (existing) {
          const keyRow = this.db
            .prepare("SELECT canonical_key FROM tracks WHERE id = ?")
            .get(existing.track_id);
          return {
            canonical,
            decision: {
              state: "existing",
              level: "EXACT_SOURCE_DUPLICATE",
              canonicalKey: keyRow?.canonical_key ?? null,
              confidence: 1,
              matchedTrackId: existing.track_id,
              candidates: [],
            },
          };
        }
      }
      const decision = this.evaluateIdentity(canonical);
      const stateByAction = {
        attach: "same_canonical",
        review: "possible_match",
        create: "created",
      };
      const levelByAction = {
        attach: "SAME_CANONICAL_TRACK",
        review: "POSSIBLE_MATCH",
        create: "DISTINCT_TRACK",
      };
      return {
        canonical,
        decision: {
          state: stateByAction[decision.action],
          level: levelByAction[decision.action],
          canonicalKey: canonical.canonicalKey,
          confidence: decision.confidence ?? decision.candidates[0]?.confidence ?? 1,
          matchedBy: decision.matchedBy,
          matchedTrackId: decision.target?.id ?? null,
          candidates: decision.candidates,
        },
      };
    } catch (error) {
      readFailed(error);
    }
  }

  mergeTracks(intoTrackId, fromTrackId) {
    this.assertOpen();
    const into = this.requireTrack(intoTrackId);
    const from = this.requireTrack(fromTrackId);
    if (into.id === from.id) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "Cannot merge a track into itself.");
    }
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE track_sources SET track_id = ? WHERE track_id = ?").run(into.id, from.id);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO track_tags (track_id, tag_id)
           SELECT ?, tag_id FROM track_tags WHERE track_id = ?`,
        )
        .run(into.id, from.id);
      this.db.prepare("DELETE FROM track_tags WHERE track_id = ?").run(from.id);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO track_playlists (track_id, playlist_id, added_at)
           SELECT ?, playlist_id, added_at FROM track_playlists WHERE track_id = ?`,
        )
        .run(into.id, from.id);
      this.db.prepare("DELETE FROM track_playlists WHERE track_id = ?").run(from.id);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO aliases (kind, value, track_id)
           SELECT kind, value, ? FROM aliases WHERE track_id = ?`,
        )
        .run(into.id, from.id);
      this.db.prepare("DELETE FROM aliases WHERE track_id = ?").run(from.id);
      if (from.canonicalKey) {
        this.db
          .prepare("INSERT OR IGNORE INTO aliases (kind, value, track_id) VALUES (?, ?, ?)")
          .run("canonical_key", from.canonicalKey, into.id);
      }

      const pendingPairs = this.db
        .prepare(
          `SELECT track_id, candidate_track_id, confidence, reason, decided_at
           FROM identity_candidates
           WHERE track_id = ? OR candidate_track_id = ?`,
        )
        .all(from.id, from.id);
      this.db
        .prepare("DELETE FROM identity_candidates WHERE track_id = ? OR candidate_track_id = ?")
        .run(from.id, from.id);
      for (const pair of pendingPairs) {
        const trackId = pair.track_id === from.id ? into.id : pair.track_id;
        const candidateId = pair.candidate_track_id === from.id ? into.id : pair.candidate_track_id;
        this.recordCandidate(trackId, candidateId, pair.confidence, pair.reason, pair.decided_at);
      }

      const remaining = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM identity_candidates
           WHERE track_id = ? OR candidate_track_id = ?`,
        )
        .get(into.id, into.id).count;
      this.db
        .prepare(
          `UPDATE tracks SET needs_review = ?, updated_at = ?,
             artist = COALESCE(artist, ?),
             language = COALESCE(language, ?),
             genre = COALESCE(genre, ?),
             mood = COALESCE(mood, ?),
             activity = COALESCE(activity, ?),
             energy = COALESCE(energy, ?),
             era = COALESCE(era, ?)
           WHERE id = ?`,
        )
        .run(
          remaining ? 1 : 0,
          now,
          from.artist ?? null,
          from.language ?? null,
          from.genre ?? null,
          from.mood ?? null,
          from.activity ?? null,
          from.energy ?? null,
          from.era ?? null,
          into.id,
        );
      this.db.prepare("DELETE FROM tracks WHERE id = ?").run(from.id);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      writeFailed(error);
    }
    return this.getTrackById(into.id);
  }

  splitTrack(trackId, sourceIds, fields = {}) {
    this.assertOpen();
    const original = this.requireTrack(trackId);
    if (!Array.isArray(sourceIds) || !sourceIds.length) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "sourceIds must be a non-empty array.");
    }
    const uniqueIds = [...new Set(sourceIds.map((id) => Number(id)))];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const owned = this.db
      .prepare(
        `SELECT id FROM track_sources WHERE track_id = ? AND id IN (${placeholders})`,
      )
      .all(original.id, ...uniqueIds)
      .map((row) => row.id);
    if (owned.length !== uniqueIds.length) {
      throw new LibraryError(
        "LIBRARY_INPUT_INVALID",
        "Every sourceId must belong to the track being split.",
      );
    }
    const overrides = {};
    for (const name of Object.keys(TRACK_COLUMNS)) {
      if (fields[name] !== undefined) overrides[name] = optionalText(fields[name], name);
    }
    const titleInput = fields.title !== undefined
      ? optionalText(fields.title, "title")
      : overrides.canonicalTitle;
    const title = titleInput ?? original.canonicalTitle;
    const artist = overrides.artist !== undefined ? overrides.artist : original.artist;
    const movedSources = this.db
      .prepare(
        `SELECT id, source_type FROM track_sources WHERE track_id = ? AND id IN (${placeholders})`,
      )
      .all(original.id, ...uniqueIds);
    const canonical = canonicalizeSource({
      title,
      artist,
      sourceType: movedSources[0]?.source_type,
    });
    const now = new Date().toISOString();

    let newTrackId;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db
        .prepare(
          `INSERT INTO tracks
            (canonical_title, artist, language, genre, mood, activity, energy, era,
             saved_at, updated_at, canonical_key, normalized_title, normalized_artist,
             identity_locked, needs_review)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`,
        )
        .run(
          title,
          artist ?? null,
          overrides.language !== undefined ? overrides.language : original.language,
          overrides.genre !== undefined ? overrides.genre : original.genre,
          overrides.mood !== undefined ? overrides.mood : original.mood,
          overrides.activity !== undefined ? overrides.activity : original.activity,
          overrides.energy !== undefined ? overrides.energy : original.energy,
          overrides.era !== undefined ? overrides.era : original.era,
          now,
          now,
          canonical.canonicalKey,
          canonical.normalizedTitle,
          canonical.normalizedArtist || null,
        );
      newTrackId = Number(result.lastInsertRowid);
      this.db
        .prepare(`UPDATE track_sources SET track_id = ? WHERE id IN (${placeholders})`)
        .run(newTrackId, ...uniqueIds);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO track_playlists (track_id, playlist_id, added_at)
           SELECT ?, playlist_id, added_at FROM track_playlists WHERE track_id = ?`,
        )
        .run(newTrackId, original.id);
      this.db
        .prepare(
          `INSERT OR IGNORE INTO track_tags (track_id, tag_id)
           SELECT ?, tag_id FROM track_tags WHERE track_id = ?`,
        )
        .run(newTrackId, original.id);
      // A split revokes earlier merge memory: the original track must stop
      // claiming the moved sources' canonical key.
      this.db
        .prepare(
          "DELETE FROM aliases WHERE track_id = ? AND kind = 'canonical_key' AND value = ?",
        )
        .run(original.id, canonical.canonicalKey);
      this.db
        .prepare(
          `UPDATE track_sources SET provenance = ?
           WHERE track_id = ? AND provenance IS NULL`,
        )
        .run(JSON.stringify({ matchedBy: "manual_split", decidedAt: now }), newTrackId);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      writeFailed(error);
    }
    return {
      track: this.getTrackById(newTrackId),
      originalTrack: this.getTrackById(original.id),
      movedSourceIds: owned,
    };
  }

  updateTrackFields(trackId, fields = {}) {
    this.assertOpen();
    const track = this.requireTrack(trackId);
    const assignments = ["updated_at = ?"];
    const params = [new Date().toISOString()];
    for (const [field, column] of Object.entries(TRACK_COLUMNS)) {
      if (fields[field] === undefined) continue;
      if (field === "canonicalTitle") continue;
      assignments.push(`${column} = ?`);
      params.push(fields[field]);
    }
    params.push(track.id);
    try {
      this.db.prepare(`UPDATE tracks SET ${assignments.join(", ")} WHERE id = ?`).run(...params);
    } catch (error) {
      writeFailed(error);
    }
    return this.getTrackById(track.id);
  }

  setIdentityLocked(trackId, locked = true) {
    this.assertOpen();
    const track = this.requireTrack(trackId);
    try {
      this.db
        .prepare("UPDATE tracks SET identity_locked = ?, updated_at = ? WHERE id = ?")
        .run(locked ? 1 : 0, new Date().toISOString(), track.id);
    } catch (error) {
      writeFailed(error);
    }
    return this.getTrackById(track.id);
  }

  setNeedsReview(trackId, needsReview = true) {
    this.assertOpen();
    const track = this.requireTrack(trackId);
    try {
      this.db
        .prepare("UPDATE tracks SET needs_review = ?, updated_at = ? WHERE id = ?")
        .run(needsReview ? 1 : 0, new Date().toISOString(), track.id);
    } catch (error) {
      writeFailed(error);
    }
    return this.getTrackById(track.id);
  }

  identityReviewQueue() {
    this.assertOpen();
    try {
      return this.db
        .prepare(
          `SELECT ic.track_id AS trackId, t.canonical_title AS trackTitle,
                  ic.candidate_track_id AS candidateTrackId,
                  c.canonical_title AS candidateTitle,
                  ic.confidence, ic.reason, ic.decided_at AS decidedAt
           FROM identity_candidates ic
           JOIN tracks t ON t.id = ic.track_id
           JOIN tracks c ON c.id = ic.candidate_track_id
           ORDER BY ic.confidence DESC, ic.decided_at DESC, ic.track_id`,
        )
        .all();
    } catch (error) {
      readFailed(error);
    }
  }

  dismissIdentityCandidate(trackId, candidateTrackId) {
    this.assertOpen();
    const track = this.requireTrack(trackId);
    const candidate = this.requireTrack(candidateTrackId);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `DELETE FROM identity_candidates
           WHERE (track_id = ? AND candidate_track_id = ?)
              OR (track_id = ? AND candidate_track_id = ?)`,
        )
        .run(track.id, candidate.id, candidate.id, track.id);
      for (const id of [track.id, candidate.id]) {
        const remaining = this.db
          .prepare(
            `SELECT COUNT(*) AS count FROM identity_candidates
             WHERE track_id = ? OR candidate_track_id = ?`,
          )
          .get(id, id).count;
        this.db
          .prepare("UPDATE tracks SET needs_review = ?, updated_at = ? WHERE id = ?")
          .run(remaining ? 1 : 0, now, id);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      writeFailed(error);
    }
    return { trackId: track.id, candidateTrackId: candidate.id };
  }

  requireTrack(trackId) {
    const id = Number(trackId);
    if (!Number.isInteger(id)) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "A numeric track id is required.");
    }
    const track = this.getTrackById(id);
    if (!track) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", `Track ${id} does not exist.`);
    }
    return track;
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

  removeTag(trackId, tag) {
    this.assertOpen();
    const track = this.requireTrack(trackId);
    const name = optionalText(tag, "tag");
    if (!name) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "A non-empty tag is required.");
    }
    try {
      this.db
        .prepare(
          `DELETE FROM track_tags
           WHERE track_id = ? AND tag_id IN (SELECT id FROM tags WHERE name = ?)`,
        )
        .run(track.id, name);
    } catch (error) {
      writeFailed(error);
    }
    return this.listTags(track.id);
  }

  listTrackSources(trackId) {
    this.assertOpen();
    try {
      return this.db
        .prepare("SELECT * FROM track_sources WHERE track_id = ? ORDER BY id")
        .all(this.requireTrack(trackId).id)
        .map(sourceRow);
    } catch (error) {
      readFailed(error);
    }
  }

  listTracks({ limit, offset } = {}) {
    this.assertOpen();
    const page = boundedPage({ limit, offset });
    try {
      const items = this.db
        .prepare("SELECT * FROM tracks ORDER BY saved_at DESC, id DESC LIMIT ? OFFSET ?")
        .all(page.limit, page.offset)
        .map(trackRow);
      const total = this.db.prepare("SELECT COUNT(*) AS count FROM tracks").get().count;
      return { items, total, ...page };
    } catch (error) {
      readFailed(error);
    }
  }

  searchTracks(filters = {}) {
    this.assertOpen();
    const page = boundedPage(filters);
    const conditions = [];
    const params = [];

    for (const [filter, columns] of [
      ["title", ["canonical_title", "normalized_title"]],
      ["artist", ["artist", "normalized_artist"]],
    ]) {
      const raw = typeof filters[filter] === "string" ? filters[filter].trim() : "";
      if (!raw) continue;
      const normalized = normalizeText(raw);
      if (normalized) {
        conditions.push(`(${columns.map((c) => `t.${c} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
        params.push(`%${escapeLike(raw)}%`, `%${escapeLike(normalized)}%`);
      } else {
        conditions.push(`t.${columns[0]} LIKE ? ESCAPE '\\'`);
        params.push(`%${escapeLike(raw)}%`);
      }
    }

    const tag = typeof filters.tag === "string" ? filters.tag.trim() : "";
    if (tag) {
      conditions.push(
        `EXISTS (SELECT 1 FROM track_tags tt JOIN tags g ON g.id = tt.tag_id
                 WHERE tt.track_id = t.id AND g.name = ?)`,
      );
      params.push(tag);
    }

    for (const dimension of SEARCH_DIMENSIONS) {
      const raw = typeof filters[dimension] === "string" ? filters[dimension].trim() : "";
      if (!raw) continue;
      conditions.push(`t.${dimension} = ?`);
      params.push(canonicalValue(dimension, raw) ?? raw);
    }

    const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";
    try {
      const items = this.db
        .prepare(
          `SELECT t.* FROM tracks t ${where}
           ORDER BY t.saved_at DESC, t.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, page.limit, page.offset)
        .map(trackRow);
      const total = this.db
        .prepare(`SELECT COUNT(*) AS count FROM tracks t ${where}`)
        .get(...params).count;
      return { items, total, ...page };
    } catch (error) {
      readFailed(error);
    }
  }

  listUnsynced({ reason, limit, offset } = {}) {
    this.assertOpen();
    const page = boundedPage({ limit, offset });
    if (reason !== undefined && reason !== null && !UNSYNCED_REASONS.includes(reason)) {
      throw new LibraryError(
        "LIBRARY_INPUT_INVALID",
        `reason must be one of: ${UNSYNCED_REASONS.join(", ")}.`,
      );
    }
    const conditions = {
      identity_conflict: "t.needs_review = 1",
      not_synced: "NOT EXISTS (SELECT 1 FROM track_playlists tp WHERE tp.track_id = t.id)",
      // Any per-track sync marker is a candidate; the parsed state decides.
      provider_unavailable: "ss.value IS NOT NULL",
    };
    const where = reason
      ? conditions[reason]
      : `(${Object.values(conditions).join(") OR (")})`;
    try {
      const rows = this.db
        .prepare(
          `SELECT t.*, ss.value AS sync_value,
                  EXISTS(SELECT 1 FROM track_playlists tp WHERE tp.track_id = t.id) AS has_playlist
           FROM tracks t
           LEFT JOIN sync_state ss ON ss.key = 'sync.' || t.id
           WHERE ${where}
           ORDER BY t.saved_at DESC, t.id DESC
           LIMIT ? OFFSET ?`,
        )
        .all(page.limit, page.offset);
      const total = this.db
        .prepare(
          `SELECT COUNT(*) AS count FROM tracks t
           LEFT JOIN sync_state ss ON ss.key = 'sync.' || t.id
           WHERE ${where}`,
        )
        .get().count;

      const items = rows.map((row) => {
        const reasons = [];
        let sync = null;
        if (row.needs_review) reasons.push("identity_conflict");
        if (!row.has_playlist) reasons.push("not_synced");
        if (typeof row.sync_value === "string" && row.sync_value) {
          try {
            sync = JSON.parse(row.sync_value);
          } catch {
            sync = null;
          }
          const state = sync?.state;
          if (typeof state === "string" && !["synced", "ok"].includes(state)) {
            reasons.push("provider_unavailable");
          }
        }
        return { track: trackRow(row), reasons, sync };
      });

      // `provider_unavailable` is decided by the parsed marker, so the SQL
      // candidate set can be wider than the final answer for that reason.
      const filtered = reason ? items.filter((item) => item.reasons.includes(reason)) : items;
      return { items: filtered, total, ...page };
    } catch (error) {
      readFailed(error);
    }
  }

  removeTrack(trackId) {
    this.assertOpen();
    const track = this.requireTrack(trackId);
    const sources = this.listTrackSources(track.id);
    const tags = this.listTags(track.id);
    const playlists = this.listTrackPlaylists(track.id);
    const deleted = {};
    this.db.exec("BEGIN IMMEDIATE");
    try {
      deleted.sources = this.db
        .prepare("DELETE FROM track_sources WHERE track_id = ?").run(track.id).changes;
      deleted.tags = this.db
        .prepare("DELETE FROM track_tags WHERE track_id = ?").run(track.id).changes;
      deleted.playlists = this.db
        .prepare("DELETE FROM track_playlists WHERE track_id = ?").run(track.id).changes;
      deleted.aliases = this.db
        .prepare("DELETE FROM aliases WHERE track_id = ?").run(track.id).changes;
      deleted.identityCandidates = this.db
        .prepare("DELETE FROM identity_candidates WHERE track_id = ? OR candidate_track_id = ?")
        .run(track.id, track.id).changes;
      deleted.syncState = this.db
        .prepare("DELETE FROM sync_state WHERE key IN (?, ?)")
        .run(`classification.${track.id}`, `sync.${track.id}`).changes;
      this.db.prepare("DELETE FROM tracks WHERE id = ?").run(track.id);
      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      writeFailed(error);
    }
    return { track, sources, tags, playlists, deleted };
  }

  listManagedPlaylists(provider = "youtube") {
    this.assertOpen();
    try {
      return this.db
        .prepare(
          `SELECT id, provider, playlist_id AS playlistId, name
           FROM playlists
           WHERE provider = ? AND playlist_id IS NOT NULL
           ORDER BY id`,
        )
        .all(provider)
        .map((row) => ({
          id: row.id,
          provider: row.provider,
          playlistId: row.playlistId,
          name: row.name ?? null,
        }));
    } catch (error) {
      readFailed(error);
    }
  }

  updatePlaylistName(provider, playlistId, name) {
    this.assertOpen();
    const cleanName = optionalText(name, "name");
    if (!cleanName) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "A non-empty playlist name is required.");
    }
    try {
      const result = this.db
        .prepare("UPDATE playlists SET name = ? WHERE provider = ? AND playlist_id = ?")
        .run(cleanName, provider, playlistId);
      if (!result.changes) {
        throw new LibraryError(
          "LIBRARY_INPUT_INVALID",
          `Playlist ${provider}:${playlistId} does not exist.`,
        );
      }
    } catch (error) {
      writeFailed(error);
    }
  }

  setSourceStatus(provider, sourceId, status) {
    this.assertOpen();
    const cleanStatus = optionalText(status, "status");
    if (!cleanStatus) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "A non-empty source status is required.");
    }
    try {
      const result = this.db
        .prepare("UPDATE track_sources SET status = ? WHERE provider = ? AND source_id = ?")
        .run(cleanStatus, provider, sourceId);
      if (!result.changes) {
        throw new LibraryError(
          "LIBRARY_INPUT_INVALID",
          `Source ${provider}:${sourceId} does not exist.`,
        );
      }
    } catch (error) {
      writeFailed(error);
    }
    return this.source(provider, sourceId);
  }

  attachPlaylist(trackId, playlist) {
    this.assertOpen();
    const track = this.requireTrack(trackId);
    if (!playlist || typeof playlist !== "object") {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "playlist must be an object.");
    }
    const provider = optionalText(playlist.provider, "playlist.provider");
    if (!provider) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "playlist.provider is required.");
    }
    try {
      this.linkPlaylist(track.id, {
        provider,
        playlistId: optionalText(playlist.playlistId, "playlist.playlistId"),
        name: optionalText(playlist.name, "playlist.name"),
      }, new Date().toISOString());
    } catch (error) {
      writeFailed(error);
    }
    return this.listTrackPlaylists(track.id);
  }

  // --- backup / restore -------------------------------------------------
  // exportRows returns every table as plain column-name rows, sorted for
  // deterministic output. sync_state rows are filtered through the same
  // secret-key guard used on write, plus a key-name scan — credential-shaped
  // data can never leave through a backup even if it bypassed setSyncState.
  exportRows() {
    this.assertOpen();
    const all = (sql) => this.db.prepare(sql).all();
    const syncState = [];
    let skippedSecrets = 0;
    for (const row of all("SELECT key, value, updated_at FROM sync_state ORDER BY key")) {
      if (SECRETISH_KEY.test(row.key)) {
        skippedSecrets += 1;
        continue;
      }
      try {
        const parsed = JSON.parse(row.value);
        assertNoSecretKeys(parsed);
        syncState.push(row);
      } catch {
        skippedSecrets += 1;
      }
    }
    return {
      tracks: all("SELECT * FROM tracks ORDER BY id"),
      sources: all("SELECT * FROM track_sources ORDER BY id"),
      playlists: all("SELECT * FROM playlists ORDER BY id"),
      trackPlaylists: all(
        "SELECT * FROM track_playlists ORDER BY track_id, playlist_id",
      ),
      tags: all("SELECT * FROM tags ORDER BY id"),
      trackTags: all("SELECT * FROM track_tags ORDER BY track_id, tag_id"),
      aliases: all("SELECT * FROM aliases ORDER BY id"),
      identityCandidates: all(
        "SELECT * FROM identity_candidates ORDER BY track_id, candidate_track_id",
      ),
      syncState,
      skippedSecrets,
    };
  }

  // importRows restores a snapshot produced by exportRows. It classifies each
  // track as insert / update / unchanged / conflict / unsupported, and when
  // apply is true performs the writes inside a single transaction — a failed
  // restore never leaves partial damage.
  importRows(data, { apply = false } = {}) {
    this.assertOpen();
    const counts = { insert: 0, update: 0, unchanged: 0, conflict: 0, unsupported: 0 };
    const conflicts = [];

    const tracksById = new Map(
      this.db.prepare("SELECT id, canonical_key FROM tracks").all()
        .map((row) => [row.id, row.canonical_key]),
    );
    const trackIdByKey = new Map(
      this.db.prepare("SELECT id, canonical_key FROM tracks WHERE canonical_key IS NOT NULL").all()
        .map((row) => [row.canonical_key, row.id]),
    );
    const sourceOwner = new Map(
      this.db.prepare("SELECT provider, source_id, track_id FROM track_sources").all()
        .map((row) => [`${row.provider}|${row.source_id}`, row.track_id]),
    );
    const playlistIdByKey = new Map();
    for (const row of this.db.prepare("SELECT id, provider, playlist_id, name FROM playlists").all()) {
      const key = row.playlist_id != null
        ? `${row.provider}|id|${row.playlist_id}`
        : `${row.provider}|name|${row.name ?? ""}`;
      playlistIdByKey.set(key, row.id);
    }
    const tagIdByName = new Map(
      this.db.prepare("SELECT id, name FROM tags").all().map((row) => [row.name, row.id]),
    );

    const hasTrackTag = (trackId, tagId) => this.db
      .prepare("SELECT 1 FROM track_tags WHERE track_id = ? AND tag_id = ?")
      .get(trackId, tagId) != null;
    const hasTrackPlaylist = (trackId, playlistRowId) => this.db
      .prepare("SELECT 1 FROM track_playlists WHERE track_id = ? AND playlist_id = ?")
      .get(trackId, playlistRowId) != null;
    const hasAlias = (kind, value, trackId) => this.db
      .prepare("SELECT 1 FROM aliases WHERE kind = ? AND value = ? AND track_id = ?")
      .get(kind, value, trackId) != null;
    const hasSyncKey = (key) => this.db
      .prepare("SELECT 1 FROM sync_state WHERE key = ?").get(key) != null;
    const hasCandidate = (trackId, candidateId) => this.db
      .prepare("SELECT 1 FROM identity_candidates WHERE track_id = ? AND candidate_track_id = ?")
      .get(trackId, candidateId) != null;

    const idMap = new Map();   // backup track id -> local track id
    const playlistMap = new Map();

    // First pass: classify every track and build the id map.
    const plan = [];
    for (const row of data.tracks) {
      if (!row.id || !row.canonical_title) {
        counts.unsupported += 1;
        continue;
      }
      const existingKey = tracksById.get(row.id);
      if (existingKey !== undefined && row.canonical_key && existingKey !== row.canonical_key) {
        counts.conflict += 1;
        conflicts.push({ trackId: row.id, reason: "id_collision", existingKey, backupKey: row.canonical_key });
        continue;
      }
      let localId = null;
      if (existingKey !== undefined) localId = row.id;
      else if (row.canonical_key && trackIdByKey.has(row.canonical_key)) {
        localId = trackIdByKey.get(row.canonical_key);
      }
      plan.push({ row, localId, action: localId == null ? "insert" : "exists" });
      // Inserts reuse the backup id, so every planned track maps immediately —
      // identity candidates can resolve both ends before any write happens.
      idMap.set(row.id, localId ?? row.id);
    }

    // Identity candidates: remap both ends through the id map; rows whose
    // tracks were refused (conflict/unsupported) can't be restored either.
    const candidatesByTrack = new Map();
    for (const row of data.identityCandidates) {
      const trackId = idMap.get(row.track_id);
      const candidateId = idMap.get(row.candidate_track_id);
      if (trackId == null || candidateId == null) {
        counts.unsupported += 1;
        continue;
      }
      if (hasCandidate(trackId, candidateId)) continue;
      const list = candidatesByTrack.get(row.track_id) ?? [];
      list.push({ ...row, track_id: trackId, candidate_track_id: candidateId });
      candidatesByTrack.set(row.track_id, list);
    }

    // Second pass: for existing tracks, decide update vs unchanged by checking
    // whether any child row is missing.
    const children = { sources: [], tags: [], playlists: [], aliases: [], candidates: [] };
    for (const entry of plan) {
      const backupId = entry.row.id;
      const sources = data.sources.filter((source) => source.track_id === backupId);
      const tags = data.trackTags
        .filter((link) => link.track_id === backupId)
        .map((link) => data.tags.find((tag) => tag.id === link.tag_id))
        .filter(Boolean);
      const playlists = data.trackPlaylists
        .filter((link) => link.track_id === backupId)
        .map((link) => ({
          link,
          playlist: data.playlists.find((playlist) => playlist.id === link.playlist_id),
        }))
        .filter((entry2) => entry2.playlist);
      const aliases = data.aliases.filter((alias) => alias.track_id === backupId);
      const syncKeys = data.syncState
        .map((state) => state.key)
        .filter((key) => key === `sync.${backupId}` || key === `classification.${backupId}`);

      if (entry.action === "insert") {
        counts.insert += 1;
        children.sources.push(...sources.map((row) => ({ ...row, track_id: backupId })));
        children.tags.push(...tags.map((row) => ({ trackId: backupId, name: row.name })));
        children.playlists.push(...playlists.map((entry2) => ({ trackId: backupId, playlist: entry2.playlist, addedAt: entry2.link.added_at })));
        children.aliases.push(...aliases.map((row) => ({ ...row, track_id: backupId })));
        children.candidates.push(...(candidatesByTrack.get(backupId) ?? []));
        continue;
      }

      const localId = entry.localId;
      const missingSources = sources.filter((source) => {
        const owner = sourceOwner.get(`${source.provider}|${source.source_id}`);
        if (owner !== undefined && owner !== localId) {
          counts.conflict += 1;
          conflicts.push({ sourceId: `${source.provider}:${source.source_id}`, reason: "source_owned_by_other_track" });
          return false;
        }
        return owner === undefined;
      });
      const missingTags = tags.filter((tag) => {
        const localTag = tagIdByName.get(tag.name);
        return localTag === undefined || !hasTrackTag(localId, localTag);
      });
      const missingPlaylists = playlists.filter(({ playlist }) => {
        const key = playlist.playlist_id != null
          ? `${playlist.provider}|id|${playlist.playlist_id}`
          : `${playlist.provider}|name|${playlist.name ?? ""}`;
        const localRow = playlistIdByKey.get(key);
        return localRow === undefined || !hasTrackPlaylist(localId, localRow);
      });
      const missingAliases = aliases.filter((alias) => !hasAlias(alias.kind, alias.value, localId));
      const missingSync = syncKeys.filter(
        (key) => !hasSyncKey(key.replace(/\.(\d+)$/, `.${localId}`)),
      );
      const missingCandidates = candidatesByTrack.get(backupId) ?? [];
      const missing = missingSources.length + missingTags.length + missingPlaylists.length
        + missingAliases.length + missingSync.length + missingCandidates.length;
      if (missing === 0) counts.unchanged += 1;
      else {
        counts.update += 1;
        children.sources.push(...missingSources.map((row) => ({ ...row, track_id: localId })));
        children.tags.push(...missingTags.map((row) => ({ trackId: localId, name: row.name })));
        children.playlists.push(...missingPlaylists.map((entry2) => ({ trackId: localId, playlist: entry2.playlist, addedAt: entry2.link.added_at })));
        children.aliases.push(...missingAliases.map((row) => ({ ...row, track_id: localId })));
        children.candidates.push(...missingCandidates);
      }
    }

    if (!apply) {
      return { counts, conflicts };
    }

    try {
      this.db.exec("BEGIN");
      const now = new Date().toISOString();
      const insertTrack = this.db.prepare(
        `INSERT INTO tracks (id, canonical_title, artist, language, genre, mood, activity,
           energy, era, saved_at, updated_at, canonical_key, normalized_title,
           normalized_artist, identity_locked, needs_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertSource = this.db.prepare(
        `INSERT INTO track_sources (track_id, provider, source_id, url, version_type,
           source_type, confidence, provenance, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertTag = this.db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)");
      const findTag = this.db.prepare("SELECT id FROM tags WHERE name = ?");
      const linkTagRow = this.db.prepare(
        "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?, ?)",
      );
      const insertPlaylist = this.db.prepare(
        "INSERT OR IGNORE INTO playlists (provider, playlist_id, name) VALUES (?, ?, ?)",
      );
      const linkPlaylistRow = this.db.prepare(
        "INSERT OR IGNORE INTO track_playlists (track_id, playlist_id, added_at) VALUES (?, ?, ?)",
      );
      const insertAlias = this.db.prepare(
        "INSERT OR IGNORE INTO aliases (kind, value, track_id) VALUES (?, ?, ?)",
      );
      const insertSync = this.db.prepare(
        "INSERT OR IGNORE INTO sync_state (key, value, updated_at) VALUES (?, ?, ?)",
      );
      const insertCandidate = this.db.prepare(
        `INSERT OR IGNORE INTO identity_candidates
           (track_id, candidate_track_id, confidence, reason, decided_at)
         VALUES (?, ?, ?, ?, ?)`,
      );

      for (const entry of plan) {
        if (entry.action !== "insert") continue;
        const row = entry.row;
        insertTrack.run(
          row.id, row.canonical_title, row.artist ?? null, row.language ?? null,
          row.genre ?? null, row.mood ?? null, row.activity ?? null, row.energy ?? null,
          row.era ?? null, row.saved_at ?? now, row.updated_at ?? now,
          row.canonical_key ?? null, row.normalized_title ?? null,
          row.normalized_artist ?? null, row.identity_locked ? 1 : 0,
          row.needs_review ? 1 : 0,
        );
      }

      for (const source of children.sources) {
        const trackId = idMap.get(source.track_id) ?? source.track_id;
        insertSource.run(
          trackId, source.provider, source.source_id, source.url ?? null,
          source.version_type ?? null, source.source_type ?? null,
          source.confidence ?? null, source.provenance ?? null,
          source.status ?? null,
        );
      }

      for (const tag of children.tags) {
        const trackId = idMap.get(tag.trackId) ?? tag.trackId;
        insertTag.run(tag.name);
        linkTagRow.run(trackId, findTag.get(tag.name).id);
      }

      for (const entry of children.playlists) {
        const trackId = idMap.get(entry.trackId) ?? entry.trackId;
        const playlist = entry.playlist;
        insertPlaylist.run(playlist.provider, playlist.playlist_id ?? null, playlist.name ?? null);
        const key = playlist.playlist_id != null
          ? `${playlist.provider}|id|${playlist.playlist_id}`
          : `${playlist.provider}|name|${playlist.name ?? ""}`;
        let localRowId = playlistMap.get(playlist.id) ?? playlistIdByKey.get(key);
        if (localRowId === undefined) {
          localRowId = this.db
            .prepare("SELECT id FROM playlists WHERE provider = ? AND playlist_id IS ? AND name IS ?")
            .get(playlist.provider, playlist.playlist_id ?? null, playlist.name ?? null)?.id;
        }
        playlistMap.set(playlist.id, localRowId);
        linkPlaylistRow.run(trackId, localRowId, entry.addedAt ?? now);
      }

      for (const alias of children.aliases) {
        const trackId = idMap.get(alias.track_id) ?? alias.track_id;
        insertAlias.run(alias.kind, alias.value, trackId);
      }

      // Track-scoped sync keys (`sync.<id>`, `classification.<id>`) are
      // remapped through idMap; all other keys copy verbatim. INSERT OR
      // IGNORE keeps re-restores idempotent and never clobbers live state.
      for (const row of data.syncState) {
        const match = /^(sync|classification)\.(\d+)$/.exec(row.key);
        if (match && idMap.has(Number(match[2]))) {
          insertSync.run(`${match[1]}.${idMap.get(Number(match[2]))}`, row.value, row.updated_at ?? now);
        } else if (!match) {
          insertSync.run(row.key, row.value, row.updated_at ?? now);
        }
      }

      for (const candidate of children.candidates) {
        insertCandidate.run(
          candidate.track_id, candidate.candidate_track_id,
          candidate.confidence, candidate.reason ?? null,
          candidate.decided_at ?? now,
        );
      }

      this.db.exec("COMMIT");
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      writeFailed(error);
    }

    return { counts, conflicts, idMap };
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

import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export class LibraryStoreError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "LibraryStoreError";
    this.code = code;
    if (options.cause) this.cause = options.cause;
  }
}

export function libraryDbPath(env = process.env) {
  if (env.MUSIC_LIBRARY_DB?.trim()) return path.resolve(env.MUSIC_LIBRARY_DB.trim());

  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir();
  const base = env.APPDATA?.trim()
    ? env.APPDATA.trim()
    : env.XDG_CONFIG_HOME?.trim() || path.join(home, ".config");
  return path.join(base, "music-playlist-organizer", "library.db");
}

export const MIGRATIONS = [
  {
    version: 1,
    name: "init",
    sql: `
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tracks (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        title_key TEXT NOT NULL,
        artist TEXT,
        artist_key TEXT NOT NULL DEFAULT '',
        album TEXT,
        language TEXT,
        genre TEXT,
        mood TEXT,
        activity TEXT,
        duration_ms INTEGER,
        saved_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (title_key, artist_key)
      );

      CREATE TABLE IF NOT EXISTS track_sources (
        id INTEGER PRIMARY KEY,
        track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'youtube',
        video_id TEXT NOT NULL,
        url TEXT,
        version_type TEXT,
        channel TEXT,
        is_primary INTEGER NOT NULL DEFAULT 0,
        added_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider, video_id)
      );

      CREATE TABLE IF NOT EXISTS playlists (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'local',
        provider_playlist_id TEXT,
        category TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (provider, name)
      );

      CREATE TABLE IF NOT EXISTS track_playlists (
        track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        added_at TEXT NOT NULL,
        PRIMARY KEY (track_id, playlist_id)
      );

      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        name_key TEXT NOT NULL UNIQUE
      );

      CREATE TABLE IF NOT EXISTS track_tags (
        track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
        PRIMARY KEY (track_id, tag_id)
      );

      CREATE TABLE IF NOT EXISTS aliases (
        id INTEGER PRIMARY KEY,
        track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        alias TEXT NOT NULL,
        alias_key TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'title',
        created_at TEXT NOT NULL,
        UNIQUE (track_id, alias_key, kind)
      );

      CREATE TABLE IF NOT EXISTS sync_state (
        track_id INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'youtube',
        provider_playlist_id TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL CHECK (status IN ('pending', 'synced', 'failed', 'unknown')),
        detail TEXT,
        synced_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (track_id, provider, provider_playlist_id)
      );

      CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_key);
      CREATE INDEX IF NOT EXISTS idx_tracks_saved ON tracks(saved_at DESC);
      CREATE INDEX IF NOT EXISTS idx_track_sources_video ON track_sources(provider, video_id);
    `,
  },
];

export const SCHEMA_VERSION = Math.max(...MIGRATIONS.map((migration) => migration.version));

const MAX_LIST_LIMIT = 500;

function now() {
  return new Date().toISOString();
}

function normalizeKey(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function requiredText(value, field) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    throw new LibraryStoreError(
      "LIBRARY_TRACK_INVALID",
      "A non-empty " + field + " is required.",
    );
  }
  return text;
}

function optionalText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function normalizeTrackInput(input) {
  if (!input || typeof input !== "object") {
    throw new LibraryStoreError("LIBRARY_TRACK_INVALID", "A track object is required.");
  }
  const title = requiredText(input.title, "title");
  const track = {
    title,
    titleKey: normalizeKey(title),
    artist: optionalText(input.artist),
    artistKey: normalizeKey(input.artist),
    album: optionalText(input.album),
    language: optionalText(input.language),
    genre: optionalText(input.genre),
    mood: optionalText(input.mood),
    activity: optionalText(input.activity),
    durationMs: Number.isFinite(Number(input.durationMs)) ? Math.round(Number(input.durationMs)) : null,
    sources: [],
    tags: [],
    playlists: [],
    aliases: [],
    sync: null,
  };

  for (const source of input.sources ?? []) {
    track.sources.push({
      provider: optionalText(source?.provider) ?? "youtube",
      videoId: requiredText(source?.videoId, "source videoId"),
      url: optionalText(source?.url),
      versionType: optionalText(source?.versionType),
      channel: optionalText(source?.channel),
      isPrimary: source?.isPrimary ? 1 : 0,
    });
  }
  for (const tag of input.tags ?? []) {
    const name = requiredText(tag, "tag");
    track.tags.push({ name, nameKey: normalizeKey(name) });
  }
  for (const playlist of input.playlists ?? []) {
    track.playlists.push({
      name: requiredText(playlist?.name, "playlist name"),
      provider: optionalText(playlist?.provider) ?? "local",
      providerPlaylistId: optionalText(playlist?.providerPlaylistId),
      category: optionalText(playlist?.category),
    });
  }
  for (const alias of input.aliases ?? []) {
    const text = requiredText(alias?.alias ?? alias, "alias");
    track.aliases.push({
      alias: text,
      aliasKey: normalizeKey(text),
      kind: optionalText(alias?.kind) ?? "title",
    });
  }
  if (input.sync && typeof input.sync === "object") {
    track.sync = {
      provider: optionalText(input.sync.provider) ?? "youtube",
      providerPlaylistId: optionalText(input.sync.providerPlaylistId) ?? "",
      status: requiredText(input.sync.status, "sync status"),
      detail: optionalText(input.sync.detail),
      syncedAt: optionalText(input.sync.syncedAt),
    };
  }
  return track;
}

function trackSummary(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    language: row.language,
    genre: row.genre,
    mood: row.mood,
    activity: row.activity,
    durationMs: row.duration_ms,
    savedAt: row.saved_at,
    updatedAt: row.updated_at,
  };
}

export class LibraryStore {
  constructor(env = process.env, dbPath = libraryDbPath(env), options = {}) {
    this.env = env;
    this.dbPath = dbPath;
    this.migrations = options.migrations ?? MIGRATIONS;
    this.targetVersion = Math.max(...this.migrations.map((migration) => migration.version));
    this.db = null;
  }

  get schemaVersion() {
    if (!this.db) return null;
    return this.db.pragma("user_version", { simple: true });
  }

  open() {
    if (this.db) return this.db;
    try {
      fs.mkdirSync(path.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new LibraryStoreError(
        "LIBRARY_OPEN_FAILED",
        "Unable to create the library directory for " + this.dbPath + ".",
        { cause: error },
      );
    }

    let db;
    try {
      db = new Database(this.dbPath);
    } catch (error) {
      throw new LibraryStoreError(
        "LIBRARY_OPEN_FAILED",
        "Unable to open the local music library at " + this.dbPath + ".",
        { cause: error },
      );
    }

    try {
      db.pragma("journal_mode = WAL");
      db.pragma("foreign_keys = ON");
      this.migrate(db);
    } catch (error) {
      db.close();
      if (error instanceof LibraryStoreError) throw error;
      throw new LibraryStoreError(
        "LIBRARY_MIGRATION_FAILED",
        "Unable to migrate the local music library at " + this.dbPath + ".",
        { cause: error },
      );
    }
    this.db = db;
    try {
      fs.chmodSync(this.dbPath, 0o600);
    } catch {
      // Windows ACLs do not map directly to POSIX modes; the file remains user-scoped by path.
    }
    return db;
  }

  migrate(db) {
    const current = db.pragma("user_version", { simple: true });
    if (current > this.targetVersion) {
      throw new LibraryStoreError(
        "LIBRARY_SCHEMA_TOO_NEW",
        "The local music library schema version " + current
          + " is newer than this server supports (" + this.targetVersion + ")."
          + " Update the server instead of deleting the database.",
      );
    }
    const pending = this.migrations
      .filter((migration) => migration.version > current)
      .sort((a, b) => a.version - b.version);
    for (const migration of pending) {
      db.transaction(() => {
        db.exec(migration.sql);
        db.prepare(
          "INSERT OR REPLACE INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        ).run(migration.version, migration.name, now());
        db.pragma("user_version = " + migration.version);
      })();
    }
  }

  close() {
    if (!this.db) return;
    this.db.close();
    this.db = null;
  }

  status() {
    try {
      const db = this.open();
      const count = (table) => db.prepare("SELECT COUNT(*) AS n FROM " + table).get().n;
      return {
        status: "READY",
        dbPath: this.dbPath,
        schemaVersion: this.schemaVersion,
        counts: {
          tracks: count("tracks"),
          sources: count("track_sources"),
          playlists: count("playlists"),
          tags: count("tags"),
        },
      };
    } catch (error) {
      return {
        status: "ERROR",
        dbPath: this.dbPath,
        error: {
          code: error instanceof LibraryStoreError ? error.code : "LIBRARY_OPEN_FAILED",
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  saveTrack(input) {
    const track = normalizeTrackInput(input);
    const db = this.open();
    try {
      return db.transaction(() => {
        const timestamp = now();
        let trackId = null;
        let created = false;

        const sourceOwners = new Set();
        for (const source of track.sources) {
          const existing = db.prepare(
            "SELECT track_id FROM track_sources WHERE provider = ? AND video_id = ?",
          ).get(source.provider, source.videoId);
          if (existing) sourceOwners.add(existing.track_id);
        }
        if (sourceOwners.size > 1) {
          throw new LibraryStoreError(
            "LIBRARY_IDENTITY_CONFLICT",
            "The supplied sources already belong to different library tracks.",
          );
        }
        trackId = sourceOwners.values().next().value ?? null;

        const refreshTrack = db.prepare(`
          UPDATE tracks SET
            title = COALESCE(?, title),
            artist = COALESCE(?, artist),
            album = COALESCE(?, album),
            language = COALESCE(?, language),
            genre = COALESCE(?, genre),
            mood = COALESCE(?, mood),
            activity = COALESCE(?, activity),
            duration_ms = COALESCE(?, duration_ms),
            updated_at = ?
          WHERE id = ?
        `);

        if (trackId === null) {
          const info = db.prepare(`
            INSERT OR IGNORE INTO tracks (
              title, title_key, artist, artist_key, album, language,
              genre, mood, activity, duration_ms, saved_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            track.title, track.titleKey, track.artist, track.artistKey, track.album,
            track.language, track.genre, track.mood, track.activity, track.durationMs,
            timestamp, timestamp,
          );
          if (info.changes === 1) {
            trackId = Number(info.lastInsertRowid);
            created = true;
          } else {
            trackId = db.prepare(
              "SELECT id FROM tracks WHERE title_key = ? AND artist_key = ?",
            ).get(track.titleKey, track.artistKey).id;
          }
        }
        if (!created) {
          refreshTrack.run(
            track.title, track.artist, track.album, track.language,
            track.genre, track.mood, track.activity, track.durationMs,
            timestamp, trackId,
          );
        }

        const upsertSource = db.prepare(`
          INSERT INTO track_sources (
            track_id, provider, video_id, url, version_type, channel,
            is_primary, added_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (provider, video_id) DO UPDATE SET
            url = COALESCE(excluded.url, track_sources.url),
            version_type = COALESCE(excluded.version_type, track_sources.version_type),
            channel = COALESCE(excluded.channel, track_sources.channel),
            is_primary = excluded.is_primary,
            updated_at = excluded.updated_at
        `);
        for (const source of track.sources) {
          upsertSource.run(
            trackId, source.provider, source.videoId, source.url,
            source.versionType, source.channel, source.isPrimary, timestamp, timestamp,
          );
        }

        const upsertTag = db.prepare(`
          INSERT INTO tags (name, name_key) VALUES (?, ?)
          ON CONFLICT (name_key) DO UPDATE SET name = tags.name
          RETURNING id
        `);
        const linkTag = db.prepare(
          "INSERT OR IGNORE INTO track_tags (track_id, tag_id) VALUES (?, ?)",
        );
        for (const tag of track.tags) {
          const { id: tagId } = upsertTag.get(tag.name, tag.nameKey);
          linkTag.run(trackId, tagId);
        }

        const upsertPlaylist = db.prepare(`
          INSERT INTO playlists (name, provider, provider_playlist_id, category, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (provider, name) DO UPDATE SET
            provider_playlist_id = COALESCE(excluded.provider_playlist_id, playlists.provider_playlist_id),
            category = COALESCE(excluded.category, playlists.category),
            updated_at = excluded.updated_at
          RETURNING id
        `);
        const linkPlaylist = db.prepare(
          "INSERT OR IGNORE INTO track_playlists (track_id, playlist_id, added_at) VALUES (?, ?, ?)",
        );
        for (const playlist of track.playlists) {
          const { id: playlistId } = upsertPlaylist.get(
            playlist.name, playlist.provider, playlist.providerPlaylistId,
            playlist.category, timestamp, timestamp,
          );
          linkPlaylist.run(trackId, playlistId, timestamp);
        }

        const addAlias = db.prepare(`
          INSERT INTO aliases (track_id, alias, alias_key, kind, created_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT (track_id, alias_key, kind) DO NOTHING
        `);
        for (const alias of track.aliases) {
          addAlias.run(trackId, alias.alias, alias.aliasKey, alias.kind, timestamp);
        }

        if (track.sync) {
          db.prepare(`
            INSERT INTO sync_state (
              track_id, provider, provider_playlist_id, status, detail, synced_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (track_id, provider, provider_playlist_id) DO UPDATE SET
              status = excluded.status,
              detail = COALESCE(excluded.detail, sync_state.detail),
              synced_at = COALESCE(excluded.synced_at, sync_state.synced_at),
              updated_at = excluded.updated_at
          `).run(
            trackId, track.sync.provider, track.sync.providerPlaylistId,
            track.sync.status, track.sync.detail,
            track.sync.syncedAt ?? (track.sync.status === "synced" ? timestamp : null),
            timestamp,
          );
        }

        return { trackId, created };
      }).immediate();
    } catch (error) {
      if (error instanceof LibraryStoreError) throw error;
      throw new LibraryStoreError(
        "LIBRARY_WRITE_FAILED",
        "Unable to write the track to the local music library.",
        { cause: error },
      );
    }
  }

  findTrackByVideoId(videoId, provider = "youtube") {
    const db = this.open();
    const row = db.prepare(`
      SELECT tracks.* FROM tracks
      JOIN track_sources ON track_sources.track_id = tracks.id
      WHERE track_sources.provider = ? AND track_sources.video_id = ?
    `).get(provider, videoId);
    return row ? trackSummary(row) : null;
  }

  getTrack(trackId) {
    const db = this.open();
    const row = db.prepare("SELECT * FROM tracks WHERE id = ?").get(trackId);
    if (!row) return null;
    return {
      ...trackSummary(row),
      sources: db.prepare(
        "SELECT provider, video_id AS videoId, url, version_type AS versionType, channel, is_primary AS isPrimary, added_at AS addedAt FROM track_sources WHERE track_id = ? ORDER BY is_primary DESC, id",
      ).all(trackId).map((source) => ({ ...source, isPrimary: Boolean(source.isPrimary) })),
      tags: db.prepare(
        "SELECT tags.name FROM tags JOIN track_tags ON track_tags.tag_id = tags.id WHERE track_tags.track_id = ? ORDER BY tags.name",
      ).all(trackId).map((tag) => tag.name),
      playlists: db.prepare(
        "SELECT playlists.name, playlists.provider, playlists.provider_playlist_id AS providerPlaylistId, playlists.category FROM playlists JOIN track_playlists ON track_playlists.playlist_id = playlists.id WHERE track_playlists.track_id = ? ORDER BY playlists.name",
      ).all(trackId),
      sync: db.prepare(
        "SELECT provider, provider_playlist_id AS providerPlaylistId, status, detail, synced_at AS syncedAt, updated_at AS updatedAt FROM sync_state WHERE track_id = ? ORDER BY provider, provider_playlist_id",
      ).all(trackId),
    };
  }

  listTracks({ artist, tag, synced, limit = 50, offset = 0 } = {}) {
    const boundedLimit = Number(limit);
    const boundedOffset = Number(offset);
    if (
      !Number.isInteger(boundedLimit) || boundedLimit < 1 || boundedLimit > MAX_LIST_LIMIT
      || !Number.isInteger(boundedOffset) || boundedOffset < 0
    ) {
      throw new LibraryStoreError(
        "LIBRARY_QUERY_INVALID",
        "limit must be an integer 1-" + MAX_LIST_LIMIT + " and offset a non-negative integer.",
      );
    }

    const conditions = [];
    const params = [];
    if (typeof artist === "string" && artist.trim()) {
      conditions.push("tracks.artist_key = ?");
      params.push(normalizeKey(artist));
    }
    if (typeof tag === "string" && tag.trim()) {
      conditions.push(
        "EXISTS (SELECT 1 FROM track_tags JOIN tags ON tags.id = track_tags.tag_id"
        + " WHERE track_tags.track_id = tracks.id AND tags.name_key = ?)",
      );
      params.push(normalizeKey(tag));
    }
    if (typeof synced === "boolean") {
      conditions.push(
        (synced ? "EXISTS" : "NOT EXISTS")
        + " (SELECT 1 FROM sync_state WHERE sync_state.track_id = tracks.id"
        + " AND sync_state.provider = 'youtube' AND sync_state.status = 'synced')",
      );
    }
    const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

    const db = this.open();
    const { total } = db.prepare("SELECT COUNT(*) AS total FROM tracks" + where).get(...params);
    const rows = db.prepare(
      "SELECT tracks.* FROM tracks" + where + " ORDER BY tracks.saved_at DESC, tracks.id DESC LIMIT ? OFFSET ?",
    ).all(...params, boundedLimit, boundedOffset);
    return { total, tracks: rows.map(trackSummary) };
  }
}

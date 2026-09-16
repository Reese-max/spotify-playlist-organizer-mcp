// library-backup: portable export/restore for the Personal Music Library.
// JSON is the lossless, versioned format (tracks, sources, tags, playlist
// mappings, aliases, identity decisions, and sync state — explicitly marked
// as a snapshot, not a live truth). CSV is a readable, intentionally lossy
// analysis format. Restore is preview-first, idempotent, schema-gated, and
// performs zero provider writes — post-restore sync goes through
// sync_youtube explicitly.

import { LibraryError } from "./library.js";

const BACKUP_FORMAT = "music-library-backup";
const BACKUP_FORMAT_VERSION = 1;
const APP_VERSION = "0.2.0";

function parseBackup(input) {
  let backup = input;
  if (typeof input === "string") {
    try {
      backup = JSON.parse(input);
    } catch {
      throw new LibraryError("LIBRARY_INPUT_INVALID", "Backup is not valid JSON.");
    }
  }
  if (!backup || typeof backup !== "object" || Array.isArray(backup)) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "Backup must be a JSON object.");
  }
  if (backup.format !== BACKUP_FORMAT) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", `Expected format "${BACKUP_FORMAT}".`);
  }
  if (backup.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new LibraryError(
      "LIBRARY_INPUT_INVALID",
      `Unsupported backup formatVersion ${backup.formatVersion}; expected ${BACKUP_FORMAT_VERSION}.`,
    );
  }
  const data = backup.data;
  const tables = ["tracks", "sources", "playlists", "trackPlaylists", "tags", "trackTags", "aliases", "identityCandidates", "syncState"];
  if (!data || typeof data !== "object" || tables.some((table) => !Array.isArray(data[table]))) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "Backup data is missing or malformed.");
  }
  return backup;
}

export function exportLibrary(library, { format = "json" } = {}) {
  const rows = library.exportRows();
  if (format === "csv") return toCsv(rows);
  if (format !== "json") {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "format must be \"json\" or \"csv\".");
  }
  const counts = {
    tracks: rows.tracks.length,
    sources: rows.sources.length,
    playlists: rows.playlists.length,
    trackPlaylists: rows.trackPlaylists.length,
    tags: rows.tags.length,
    aliases: rows.aliases.length,
    identityCandidates: rows.identityCandidates.length,
    syncState: rows.syncState.length,
  };
  return JSON.stringify({
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    app: "music-playlist-organizer",
    appVersion: APP_VERSION,
    schemaVersion: library.schemaVersion(),
    exportedAt: new Date().toISOString(),
    meta: {
      syncStateIsSnapshot: true,
      note: "Sync state is a point-in-time snapshot; provider playlists may have changed since export. Re-run sync_status / sync_youtube after restore.",
    },
    counts,
    excluded: { secrets: rows.skippedSecrets },
    data: {
      tracks: rows.tracks,
      sources: rows.sources,
      playlists: rows.playlists,
      trackPlaylists: rows.trackPlaylists,
      tags: rows.tags,
      trackTags: rows.trackTags,
      aliases: rows.aliases,
      identityCandidates: rows.identityCandidates,
      syncState: rows.syncState,
    },
  }, null, 2);
}

export function restoreLibrary(library, input, { mode = "preview" } = {}) {
  const backup = parseBackup(input);
  if (backup.schemaVersion !== library.schemaVersion()) {
    throw new LibraryError(
      "LIBRARY_INPUT_INVALID",
      `Backup schemaVersion ${backup.schemaVersion} is incompatible with library schemaVersion ${library.schemaVersion()}; nothing was written.`,
    );
  }
  const apply = mode === "apply";
  const { counts, conflicts } = library.importRows(backup.data, { apply });
  return {
    mode: apply ? "apply" : "preview",
    backupExportedAt: backup.exportedAt ?? null,
    counts,
    conflicts,
    providerWrites: 0,
    ...(apply
      ? { nextStep: "Sync state was restored as a snapshot; run sync_youtube (preview first) to reconcile against the live provider." }
      : { nextStep: "Re-run restore_library with mode \"apply\" to write this plan." }),
  };
}

// Readable, intentionally lossy: one row per track with joined source ids,
// tags, and playlist names. Restore must go through the JSON format.
function toCsv(rows) {
  const escape = (value) => {
    const text = String(value ?? "");
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const sourcesByTrack = new Map();
  for (const source of rows.sources) {
    const list = sourcesByTrack.get(source.track_id) ?? [];
    if (source.provider === "youtube") list.push(source.source_id);
    sourcesByTrack.set(source.track_id, list);
  }
  const tagsByTrack = new Map();
  const tagName = new Map(rows.tags.map((tag) => [tag.id, tag.name]));
  for (const link of rows.trackTags) {
    const list = tagsByTrack.get(link.track_id) ?? [];
    list.push(tagName.get(link.tag_id));
    tagsByTrack.set(link.track_id, list);
  }
  const playlistName = new Map(rows.playlists.map((playlist) => [playlist.id, playlist.name ?? playlist.playlist_id]));
  const playlistsByTrack = new Map();
  for (const link of rows.trackPlaylists) {
    const list = playlistsByTrack.get(link.track_id) ?? [];
    list.push(playlistName.get(link.playlist_id));
    playlistsByTrack.set(link.track_id, list);
  }

  const header = "canonical_title,artist,language,genre,mood,activity,energy,era,saved_at,needs_review,youtube_ids,tags,playlists";
  const lines = rows.tracks.map((track) => [
    track.canonical_title,
    track.artist,
    track.language,
    track.genre,
    track.mood,
    track.activity,
    track.energy,
    track.era,
    track.saved_at,
    track.needs_review ? "yes" : "no",
    (sourcesByTrack.get(track.id) ?? []).join(";"),
    (tagsByTrack.get(track.id) ?? []).sort().join(";"),
    (playlistsByTrack.get(track.id) ?? []).join(";"),
  ].map(escape).join(","));
  return `${header}\n${lines.join("\n")}\n`;
}

// library-query: MCP-facing read and maintenance operations for the local
// Personal Music Library. All SQL lives in MusicLibrary (src/library.js);
// this module only orchestrates public library APIs, classification, and
// the optional YouTube remove effect. Queries are read-only; the only write
// paths are updateMusicTags, reclassifyMusic, and removeMusic, and removal
// stays preview/apply with per-effect authorization.

import { LibraryError } from "./library.js";
import {
  classificationSyncKey,
  classifyMusic,
  persistClassification,
} from "./classify.js";
import { DIMENSIONS } from "./taxonomy.js";
import { parseYouTubePlaylistReference } from "./youtube.js";

const MAX_LIMIT = 100;

function boundedLimit(limit, fallback = 20) {
  return Math.min(Math.max(Math.trunc(Number(limit)) || fallback, 1), MAX_LIMIT);
}

function boundedOffset(offset) {
  return Math.max(Math.trunc(Number(offset)) || 0, 0);
}

function optionalString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function requireTrack(library, trackId) {
  const id = Number(trackId);
  if (!Number.isInteger(id)) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "A numeric trackId is required.");
  }
  const track = library.getTrackById(id);
  if (!track) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", `Track ${id} does not exist.`);
  }
  return track;
}

function readJson(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function errorInfo(error) {
  return {
    code: error?.code ?? "WRITE_FAILED",
    message: error instanceof Error ? error.message : String(error),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  };
}

// Same ambiguity rule as save_music: timeouts, cancellations, network
// failures, 429 and 5xx mean the provider may have applied the write.
function isAmbiguousWriteError(error) {
  return ["TIMEOUT", "CALLER_CANCELLED", "NETWORK_ERROR"].includes(error?.code)
    || error?.status === 429
    || error?.status >= 500;
}

function classificationDiff(before, after) {
  const diff = {};
  for (const dimension of DIMENSIONS) {
    const priorValues = new Set(
      (before?.dimensions?.[dimension] ?? []).map((entry) => entry.value),
    );
    const nextValues = new Set(
      (after?.dimensions?.[dimension] ?? []).map((entry) => entry.value),
    );
    const added = [...nextValues].filter((value) => !priorValues.has(value));
    const removed = [...priorValues].filter((value) => !nextValues.has(value));
    if (added.length || removed.length) diff[dimension] = { added, removed };
  }
  return diff;
}

function readStoredClassification(library, trackId) {
  return readJson(library.getSyncState(classificationSyncKey(trackId)));
}

function readStoredSync(library, trackId) {
  return readJson(library.getSyncState(`sync.${trackId}`));
}

export function searchLibrary(library, args = {}) {
  const result = library.searchTracks({
    title: args.title,
    artist: args.artist,
    tag: args.tag,
    genre: args.genre,
    mood: args.mood,
    language: args.language,
    activity: args.activity,
    limit: args.limit,
    offset: args.offset,
  });
  return { ...result, hasMore: result.offset + result.items.length < result.total };
}

export function listMusic(library, args = {}) {
  const result = library.listTracks({ limit: args.limit, offset: args.offset });
  return { ...result, hasMore: result.offset + result.items.length < result.total };
}

export function recentMusic(library, args = {}) {
  const limit = boundedLimit(args.limit);
  return { items: library.listRecent(limit), limit };
}

export function getMusic(library, args = {}) {
  const track = requireTrack(library, args.trackId);
  const identityReview = library.identityReviewQueue().filter(
    (entry) => entry.trackId === track.id || entry.candidateTrackId === track.id,
  );
  return {
    track,
    sources: library.listTrackSources(track.id),
    tags: library.listTags(track.id),
    playlists: library.listTrackPlaylists(track.id),
    classification: readStoredClassification(library, track.id),
    sync: readStoredSync(library, track.id),
    identityReview,
  };
}

export function updateMusicTags(library, args = {}) {
  const track = requireTrack(library, args.trackId);
  const normalize = (list) => (Array.isArray(list)
    ? [...new Set(list.map((tag) => String(tag ?? "").trim()).filter(Boolean))]
    : []);
  const add = normalize(args.add);
  const remove = normalize(args.remove);

  const before = library.listTags(track.id);
  // Removals run first, so a tag present in both lists ends up attached.
  for (const tag of remove) library.removeTag(track.id, tag);
  for (const tag of add) library.addTag(track.id, tag);
  const after = library.listTags(track.id);

  return {
    trackId: track.id,
    before,
    after,
    added: after.filter((tag) => !before.includes(tag)),
    removed: before.filter((tag) => !after.includes(tag)),
  };
}

// Re-run automatic classification for a stored track. The stored user-set
// dimensions and tags survive via mergeClassification inside
// persistClassification; the result is the before/after diff.
export async function reclassifyMusic(library, args = {}) {
  const track = requireTrack(library, args.trackId);
  const sources = library.listTrackSources(track.id);
  if (!sources.length) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", `Track ${track.id} has no sources to classify from.`);
  }
  const first = sources[0];
  const channelTitle = sources
    .map((source) => source.provenance?.channelTitle)
    .find((value) => typeof value === "string" && value.trim()) ?? null;

  const before = readStoredClassification(library, track.id);
  const next = await classifyMusic({
    title: track.canonicalTitle,
    artist: track.artist,
    channelTitle,
  });
  const saved = persistClassification(
    library,
    {
      title: track.canonicalTitle,
      artist: track.artist,
      source: {
        provider: first.provider,
        sourceId: first.sourceId,
        url: first.url ?? undefined,
        channelTitle: channelTitle ?? undefined,
      },
    },
    next,
  );

  return {
    trackId: saved.trackId,
    before,
    after: saved.classification,
    diff: classificationDiff(before, saved.classification),
    preserved: saved.preserved ?? [],
  };
}

// remove_music: preview by default. In apply mode only explicitly authorized
// effects run — local library deletion and YouTube playlist-item deletion are
// independent and never trigger each other.
export async function removeMusic({ library, youtube }, args = {}, { signal } = {}) {
  const track = requireTrack(library, args.trackId);
  const mode = args.mode === "apply" ? "apply" : "preview";
  const local = args.local === true;
  const playlistRef = optionalString(args.youtubePlaylist);
  const videoIdArg = optionalString(args.videoId);

  const sources = library.listTrackSources(track.id);
  const tags = library.listTags(track.id);
  const playlists = library.listTrackPlaylists(track.id);

  // The YouTube effect needs an exact playlist ID/URL — a display name is not
  // a stable identifier and could hit the wrong playlist.
  let playlistId = null;
  if (playlistRef) {
    const parsed = parseYouTubePlaylistReference(playlistRef);
    if (!parsed.id) {
      throw new LibraryError(
        "LIBRARY_INPUT_INVALID",
        "youtubePlaylist must be an exact playlist ID or URL, not a name.",
      );
    }
    playlistId = parsed.id;
  }

  const youtubeSources = sources.filter((source) => source.provider === "youtube");
  let videoId = videoIdArg;
  let videoIdError = null;
  if (playlistId && !videoId) {
    if (youtubeSources.length === 1) {
      videoId = youtubeSources[0].sourceId;
    } else {
      videoIdError = youtubeSources.length === 0
        ? "The track has no YouTube source; pass videoId explicitly."
        : "The track has multiple YouTube sources; pass videoId explicitly.";
    }
  }

  const effects = {
    local: {
      authorized: local,
      writeState: local ? "PREVIEW" : "NOT_REQUESTED",
      wouldDelete: { sources: sources.length, tags, playlists },
    },
    youtubePlaylistItem: {
      authorized: Boolean(playlistId),
      writeState: playlistId ? "PREVIEW" : "NOT_REQUESTED",
      playlistId,
      videoId,
      knownPlaylists: playlists.filter(
        (playlist) => playlist.provider === "youtube" && playlist.playlistId,
      ),
      ...(videoIdError
        ? { error: { code: "LIBRARY_INPUT_INVALID", message: videoIdError } }
        : {}),
    },
  };

  if (mode === "preview") {
    return {
      mode,
      action: "preview",
      track,
      effects,
      nextStep: "Re-run with mode \"apply\" to execute the authorized effects.",
    };
  }

  if (!local && !playlistId) {
    return {
      mode,
      action: "no_effect_authorized",
      track,
      effects,
      message: "Nothing was removed. Pass local: true and/or youtubePlaylist to authorize an effect.",
    };
  }

  let removed = 0;
  let failed = 0;

  if (local) {
    try {
      const deleted = library.removeTrack(track.id);
      effects.local = {
        authorized: true,
        writeState: "REMOVED",
        deleted: deleted.deleted,
        removed: { track, sources, tags, playlists },
      };
      removed += 1;
    } catch (error) {
      effects.local = {
        authorized: true,
        writeState: "FAILED_NO_CONFIRMED_EFFECT",
        error: errorInfo(error),
      };
      failed += 1;
    }
  }

  if (playlistId) {
    if (videoIdError) {
      effects.youtubePlaylistItem = {
        authorized: true,
        playlistId,
        videoId: null,
        writeState: "FAILED_NO_CONFIRMED_EFFECT",
        error: { code: "LIBRARY_INPUT_INVALID", message: videoIdError },
      };
      failed += 1;
    } else if (typeof youtube?.removeVideoFromPlaylist !== "function") {
      effects.youtubePlaylistItem = {
        authorized: true,
        playlistId,
        videoId,
        writeState: "FAILED_NO_CONFIRMED_EFFECT",
        error: { code: "PROVIDER_UNAVAILABLE", message: "The YouTube client is unavailable." },
      };
      failed += 1;
    } else {
      try {
        const outcome = await youtube.removeVideoFromPlaylist(playlistId, videoId, { signal });
        effects.youtubePlaylistItem = {
          authorized: true,
          playlistId,
          videoId,
          writeState: outcome.removed ? "REMOVED" : "NOT_PRESENT",
          result: outcome,
        };
        removed += 1;
      } catch (error) {
        effects.youtubePlaylistItem = {
          authorized: true,
          playlistId,
          videoId,
          writeState: isAmbiguousWriteError(error)
            ? "UNKNOWN_AFTER_WRITE"
            : "FAILED_NO_CONFIRMED_EFFECT",
          error: errorInfo(error),
        };
        failed += 1;
      }
    }
  }

  const action = failed === 0
    ? "removed"
    : removed > 0
      ? "partial_failure"
      : "failed";

  return {
    mode,
    action,
    track,
    effects,
    ...(failed
      ? { nextStep: "Check each failed effect's error; re-run only the failed effect — completed effects are idempotent." }
      : {}),
  };
}

export function listUnsyncedMusic(library, args = {}) {
  const result = library.listUnsynced({
    reason: args.reason,
    limit: boundedLimit(args.limit),
    offset: boundedOffset(args.offset),
  });
  return { ...result, hasMore: result.offset + result.items.length < result.total };
}

// save_music: the unified product-level entry point. One call identifies a
// song (name or YouTube/YouTube Music URL), binds the selected video,
// canonicalizes and dedupes it against the local library, classifies it,
// persists it, optionally syncs it to a YouTube playlist, and returns a
// complete per-step receipt. Library and YouTube writes are independent:
// a failure on one side is reported truthfully instead of collapsing the
// whole call into a generic error.

import { classifyTrack, DEFAULT_RULES, parseLink } from "./core.js";
import {
  classificationToTrackFields,
  classifyMusic,
  persistClassification,
} from "./classify.js";
import { canonicalizeSource } from "./canonical.js";
import {
  parseYouTubePlaylistReference,
  youtubePlaylistUrl,
  youtubeVideoUrl,
} from "./youtube.js";

function boundedName(name) {
  return String(name).trim().slice(0, 100);
}

function errorInfo(error) {
  return {
    code: error?.code ?? "WRITE_FAILED",
    message: error instanceof Error ? error.message : String(error),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  };
}

// Same ambiguity rule as youtube_save_track: timeouts, cancellations,
// network failures, 429 and 5xx mean the provider may have applied the
// write without us seeing the confirmation. Never blindly retried.
function isAmbiguousWriteError(error) {
  return ["TIMEOUT", "CALLER_CANCELLED", "NETWORK_ERROR"].includes(error?.code)
    || error?.status === 429
    || error?.status >= 500;
}

async function bindVideo(youtube, { input, videoId, limit = 5, signal } = {}) {
  if (videoId) {
    return {
      bound: true,
      source: {
        kind: "youtube-video-selection",
        id: videoId,
        url: youtubeVideoUrl(videoId),
        input,
      },
      match: await youtube.getVideo(videoId, { signal }),
    };
  }

  const source = parseLink(input);
  if (source.kind === "youtube-video") {
    return { bound: true, source, match: await youtube.getVideo(source.id, { signal }) };
  }
  if (source.kind === "youtube-playlist") {
    throw new Error("The supplied YouTube link is a playlist; provide a video link or song name instead.");
  }
  if (source.kind === "spotify-track" || source.kind === "spotify-playlist") {
    throw new Error("save_music accepts YouTube/YouTube Music links, video IDs, or search text; use the spotify_* tools for Spotify links.");
  }
  // A bare 11-character video ID is an exact reference, not a search query.
  if (/^[A-Za-z0-9_-]{11}$/.test(String(input).trim())) {
    const id = String(input).trim();
    return {
      bound: true,
      source: { kind: "youtube-video", id, url: youtubeVideoUrl(id), input },
      match: await youtube.getVideo(id, { signal }),
    };
  }

  const search = await youtube.searchVideos(input, { limit, signal });
  if (!search.videos.length) {
    throw new Error("No YouTube video matched the supplied input.");
  }
  return { bound: false, source, candidates: search.videos };
}

async function loadTargetPlaylist(youtube, reference, { signal } = {}) {
  const parsed = parseYouTubePlaylistReference(reference);
  if (parsed.id) {
    const [details, items] = await Promise.all([
      youtube.getPlaylist(parsed.id, { signal }),
      youtube.getPlaylistItems(parsed.id, { signal }),
    ]);
    return { id: parsed.id, details, items };
  }

  const available = await youtube.listPlaylists({ limit: 500, signal });
  const match = available.playlists.find(
    (playlist) => playlist.name.trim().toLocaleLowerCase() === parsed.name.trim().toLocaleLowerCase(),
  );
  if (!match) {
    return { id: null, details: { name: parsed.name }, items: [] };
  }
  return {
    id: match.id,
    details: match,
    items: await youtube.getPlaylistItems(match.id, { signal }),
  };
}

function playlistInfo(loaded, fallbackName) {
  const name = loaded.details?.name ?? loaded.name ?? fallbackName ?? null;
  return {
    id: loaded.id ?? null,
    name,
    url: loaded.id ? youtubePlaylistUrl(loaded.id) : null,
  };
}

async function runYouTubeStep(youtube, {
  video,
  targetReference,
  selectedCategory,
  mode,
  signal,
  completedSteps,
}) {
  let loaded;
  try {
    loaded = await loadTargetPlaylist(youtube, targetReference, { signal });
  } catch (error) {
    return {
      enabled: true,
      action: mode === "preview" ? "preview_unavailable" : "failed",
      writeState: "FAILED_NO_CONFIRMED_EFFECT",
      target: targetReference,
      videoId: video.id,
      error: errorInfo(error),
      ...(mode === "apply"
        ? { nextStep: "Fix the playlist lookup error and re-run the same save_music call; the library write is idempotent." }
        : {}),
    };
  }

  const targetName = loaded.details?.name ?? targetReference;
  const duplicate = loaded.id
    ? loaded.items.find((item) => item.id === video.id) ?? null
    : null;
  const base = {
    enabled: true,
    videoId: video.id,
    playlist: playlistInfo(loaded, targetName),
    playlistAction: loaded.id ? "use_existing" : "create_if_missing",
    duplicate: Boolean(duplicate),
    existingItem: duplicate,
  };

  if (mode === "preview") {
    return {
      ...base,
      action: duplicate ? "would_skip_duplicate" : "would_add",
      writeState: "PREVIEW",
    };
  }

  if (duplicate) {
    completedSteps.push("youtube_already_present");
    return { ...base, action: "skipped_duplicate", writeState: "ALREADY_PRESENT" };
  }

  let target = loaded;
  let createdPlaylist = false;
  try {
    if (!target.id) {
      const created = await youtube.createPlaylist(
        targetName,
        "Managed by music-playlist-organizer-mcp. Category: " + selectedCategory,
        "private",
        { signal },
      );
      target = { id: created.id, details: created, items: [] };
      createdPlaylist = true;
      completedSteps.push("youtube_playlist_created");
    }
    await youtube.addVideoToPlaylist(target.id, video.id, { signal });
    completedSteps.push("youtube_video_added");
    return {
      ...base,
      playlist: playlistInfo(target, targetName),
      playlistAction: createdPlaylist ? "created" : "use_existing",
      action: "added",
      writeState: "SYNCED",
    };
  } catch (error) {
    return {
      ...base,
      playlist: playlistInfo(target, targetName),
      playlistAction: createdPlaylist ? "created" : loaded.id ? "use_existing" : "unknown",
      action: "reconciliation_required",
      writeState: isAmbiguousWriteError(error)
        ? "UNKNOWN_AFTER_WRITE"
        : createdPlaylist
          ? "PARTIAL_PLAYLIST_CREATED"
          : "FAILED_NO_CONFIRMED_EFFECT",
      error: errorInfo(error),
      nextStep: createdPlaylist
        ? "Use the returned playlist ID, read its items, and only retry if the exact video ID is absent."
        : "Read the target playlist by exact ID before retrying; do not create another playlist.",
    };
  }
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(
    tags.map((tag) => String(tag ?? "").trim()).filter(Boolean),
  )];
}

export async function saveMusic({ youtube, library }, args = {}, { signal } = {}) {
  const input = args.input;
  const mode = args.mode === "apply" ? "apply" : "preview";
  const syncToYouTube = args.syncToYouTube !== false;
  const category = typeof args.category === "string" && args.category.trim()
    ? args.category.trim()
    : null;
  const tags = normalizeTags(args.tags);
  const userTags = category && !tags.includes(category) ? [...tags, category] : tags;

  const bound = await bindVideo(youtube, { input, videoId: args.videoId, signal });
  if (!bound.bound) {
    return {
      mode,
      action: "selection_required",
      input,
      source: bound.source,
      candidates: bound.candidates,
      tags: userTags,
      completedSteps: [],
      ids: { videoId: null, trackId: null, playlistId: null },
      syncState: "not_started",
      message: "Free-text input is not uniquely bound to a video; nothing was written.",
      nextStep: "Pick a candidate and re-run save_music with the same input plus its videoId.",
    };
  }
  const video = bound.match;

  const classification = await classifyMusic({
    title: video.name,
    channelTitle: video.channel,
    description: video.description,
    userClassification: userTags.length ? { custom_tags: userTags } : undefined,
  });
  const classFields = classificationToTrackFields(classification);

  const librarySource = {
    provider: "youtube",
    sourceId: video.id,
    url: video.url ?? youtubeVideoUrl(video.id),
    channelTitle: video.channel ?? null,
  };

  // Read-only identity evaluation; the real decision in apply mode comes back
  // from upsertTrack.identity via persistClassification.
  let canonicalData = null;
  let identityDecision = null;
  let libraryReadError = null;
  try {
    const previewed = library.previewIdentity({
      title: video.name,
      artist: classFields.artist ?? undefined,
      source: librarySource,
    });
    canonicalData = previewed.canonical;
    identityDecision = previewed.decision;
  } catch (error) {
    libraryReadError = errorInfo(error);
  }
  if (!canonicalData) {
    canonicalData = canonicalizeSource({ title: video.name, channelTitle: video.channel });
  }

  const selectedCategory = category ?? classifyTrack(video, DEFAULT_RULES);
  const prefix = youtube.env?.YOUTUBE_PLAYLIST_PREFIX?.trim() || "";
  const generatedName = boundedName((prefix ? prefix + " · " : "") + selectedCategory);
  const targetReference = typeof args.playlist === "string" && args.playlist.trim()
    ? args.playlist.trim()
    : generatedName;

  const completedSteps = [];
  const youtubeStep = syncToYouTube
    ? await runYouTubeStep(youtube, {
      video,
      targetReference,
      selectedCategory,
      mode,
      signal,
      completedSteps,
    })
    : { enabled: false, action: "disabled", writeState: "NOT_REQUESTED" };

  let libraryStep;
  let identity = identityDecision;
  let finalClassification = classification;
  if (mode === "preview") {
    libraryStep = libraryReadError
      ? { action: "preview_unavailable", writeState: "UNAVAILABLE", error: libraryReadError }
      : {
        action: "would_save",
        writeState: "PREVIEW",
        trackId: identityDecision?.matchedTrackId ?? null,
      };
  } else {
    try {
      const targetPlaylist = youtubeStep.playlist;
      const playlistRecord = targetPlaylist && (targetPlaylist.id || targetPlaylist.name)
        ? {
          provider: "youtube",
          playlistId: targetPlaylist.id ?? null,
          name: targetPlaylist.name ?? null,
        }
        : null;
      const saved = persistClassification(
        library,
        {
          title: video.name,
          artist: classFields.artist ?? undefined,
          source: librarySource,
          ...(playlistRecord ? { playlist: playlistRecord } : {}),
        },
        classification,
      );
      completedSteps.push("library_saved");
      identity = saved.identity ?? identity;
      finalClassification = saved.classification;
      libraryStep = {
        action: saved.identity?.state === "existing" ? "existing" : "saved",
        trackId: saved.trackId,
        writeState: "SAVED",
        preserved: saved.preserved ?? [],
      };
    } catch (error) {
      libraryStep = {
        action: "failed",
        trackId: null,
        writeState: "FAILED",
        error: errorInfo(error),
      };
    }
  }

  const libraryOk = libraryStep.writeState === "SAVED";
  const youtubeOk = !syncToYouTube
    || youtubeStep.action === "added"
    || youtubeStep.action === "skipped_duplicate";
  const youtubeAmbiguous = syncToYouTube
    && ["UNKNOWN_AFTER_WRITE", "PARTIAL_PLAYLIST_CREATED"].includes(youtubeStep.writeState);

  let action;
  if (mode === "preview") {
    action = identity?.level === "EXACT_SOURCE_DUPLICATE" && youtubeStep.duplicate
      ? "would_skip_duplicate"
      : "would_save";
  } else if (libraryOk && youtubeOk) {
    action = youtubeStep.action === "skipped_duplicate" && identity?.level === "EXACT_SOURCE_DUPLICATE"
      ? "skipped_duplicate"
      : "saved";
  } else if (youtubeAmbiguous) {
    action = "reconciliation_required";
  } else if (libraryOk || youtubeOk) {
    action = "partial_failure";
  } else {
    action = "failed";
  }

  let syncState;
  if (mode === "preview") {
    syncState = "preview";
  } else if (!syncToYouTube) {
    syncState = "not_requested";
  } else if (youtubeOk && libraryOk) {
    syncState = "synced";
  } else if (youtubeAmbiguous) {
    syncState = "unknown";
  } else if (libraryOk || youtubeOk) {
    syncState = "partial";
  } else {
    syncState = "failed";
  }

  let nextStep = null;
  if (mode === "preview") {
    nextStep = "Re-run with mode \"apply\" to write.";
  }
  if (youtubeAmbiguous) {
    nextStep = youtubeStep.nextStep;
    if (!libraryOk) {
      nextStep += " The local library write also failed; re-run after reconciling YouTube.";
    }
  } else if (mode === "apply" && !libraryOk) {
    nextStep = "The local library write failed; re-run the same save_music call after fixing the library error — the YouTube side is deduplicated and the retry is idempotent.";
  } else if (mode === "apply" && syncToYouTube && !youtubeOk) {
    nextStep = youtubeStep.nextStep
      ?? "The YouTube write failed before any confirmed change; the track is saved in the local library — fix the reported error and re-run the same call.";
  }
  if (identity?.level === "POSSIBLE_MATCH" && action !== "reconciliation_required") {
    nextStep = (nextStep ? nextStep + " " : "")
      + "The track was stored as a possible duplicate (needs_review); inspect the identity review queue and merge or split if it is the same song.";
  }

  return {
    mode,
    action,
    input,
    source: bound.source,
    video,
    canonical: {
      ...canonicalData,
      canonicalKey: identity?.canonicalKey ?? canonicalData.canonicalKey,
      state: identity?.state ?? "unknown",
      level: identity?.level ?? "UNKNOWN",
      confidence: identity?.confidence ?? null,
      matchedTrackId: identity?.matchedTrackId ?? null,
      ...(identity?.matchedBy ? { matchedBy: identity.matchedBy } : {}),
      candidates: identity?.candidates ?? [],
    },
    classification: finalClassification,
    tags: userTags,
    provenance: finalClassification.provenance,
    library: libraryStep,
    youtube: youtubeStep,
    duplicate: {
      level: identity?.level ?? "UNKNOWN",
      state: identity?.state ?? "unknown",
      youtubePlaylistItem: youtubeStep.duplicate ?? false,
    },
    syncState,
    completedSteps,
    ids: {
      videoId: video.id,
      trackId: libraryStep.trackId ?? identity?.matchedTrackId ?? null,
      playlistId: youtubeStep.playlist?.id ?? null,
    },
    ...(nextStep ? { nextStep } : {}),
  };
}

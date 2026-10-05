// save_music: the unified product-level entry point. One call identifies a
// song (name or YouTube/YouTube Music URL), binds the selected video,
// canonicalizes and dedupes it against the local library, classifies it,
// persists it, optionally syncs it to a YouTube playlist, and returns a
// complete per-step receipt. Library and YouTube writes are independent:
// a failure on one side is reported truthfully instead of collapsing the
// whole call into a generic error.

import { classifyTrack, DEFAULT_RULES, parseLink } from "./core.js";
import { ProviderRequestError, REQUEST_CODES } from "./http.js";
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
  remoteDedupe = "canonical",
  siblingVideoIds = [],
  canonicalKey = null,
  siblingSourcesError = null,
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
  const exactDuplicate = loaded.id
    ? loaded.items.find((item) => item.id === video.id) ?? null
    : null;
  // Canonical policy: the same song may already sit in the playlist under a
  // different YouTube upload (e.g. Official MV vs Official Audio). Membership
  // is proven two ways: a sibling source of the matched canonical track, or a
  // playlist item whose metadata canonicalizes to the same key — the latter
  // also catches uploads the local library has never seen. The exact-source
  // policy only skips this videoId.
  const canonicalDuplicate = remoteDedupe === "canonical" && !exactDuplicate
    ? loaded.items.find((item) => (
      siblingVideoIds.includes(item.id)
      || (canonicalKey != null
        && canonicalizeSource({ title: item.name, channelTitle: item.channel }).canonicalKey
          === canonicalKey)
    )) ?? null
    : null;
  const duplicate = exactDuplicate ?? canonicalDuplicate;
  const duplicateKind = exactDuplicate
    ? "exact_source"
    : canonicalDuplicate
      ? "canonical_track"
      : null;
  const base = {
    enabled: true,
    videoId: video.id,
    playlist: playlistInfo(loaded, targetName),
    playlistAction: loaded.id ? "use_existing" : "create_if_missing",
    dedupePolicy: remoteDedupe,
    duplicate: Boolean(duplicate),
    duplicateKind,
    matchedVideoId: duplicate?.id ?? null,
    existingItem: duplicate,
    ...(siblingSourcesError ? { dedupeError: siblingSourcesError } : {}),
  };

  if (mode === "preview") {
    return {
      ...base,
      action: duplicate
        ? duplicateKind === "canonical_track"
          ? "would_skip_canonical_duplicate"
          : "would_skip_duplicate"
        : "would_add",
      writeState: "PREVIEW",
    };
  }

  if (duplicate) {
    if (duplicateKind === "canonical_track") {
      completedSteps.push("youtube_canonical_already_present");
      return {
        ...base,
        action: "skipped_canonical_duplicate",
        writeState: "ALREADY_PRESENT",
        nextStep: "The playlist already contains another source of the same canonical track; re-run with remoteDedupe \"source\" to add this video anyway.",
      };
    }
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

// One client can receive overlapping stdio or HTTP saves. Hold each provider
// read-before-write sequence by its overlapping identities: exact video,
// canonical song, and playlist name when creation may be needed. Acquiring
// keys in sorted order prevents cycles between different combinations.
const youtubeWriteLocks = new WeakMap();

function writeLockKeys({ videoId, canonicalKey, remoteDedupe, targetReference }) {
  const keys = [`video:${videoId}`];
  if (remoteDedupe === "canonical" && canonicalKey) {
    keys.push(`canonical:${canonicalKey}`);
  }
  try {
    const parsed = parseYouTubePlaylistReference(targetReference);
    if (!parsed.id && parsed.name) {
      keys.push(`playlist-name:${parsed.name.trim().toLocaleLowerCase()}`);
    }
  } catch {
    // runYouTubeStep reports invalid playlist references in its normal receipt.
  }
  return keys.sort();
}

function callerCancelled(operation) {
  return new ProviderRequestError(
    REQUEST_CODES.CALLER_CANCELLED,
    operation + " was cancelled by the caller.",
    { retryable: true },
  );
}

// Waits on the previous write holding a key, but wakes promptly on caller
// cancellation with the typed CALLER_CANCELLED outcome instead of a bare
// AbortError once the lock finally frees.
function waitForWriteLock(previous, signal) {
  if (signal?.aborted) return Promise.reject(callerCancelled("YouTube write"));
  if (!signal) return previous;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(callerCancelled("YouTube write"));
    signal.addEventListener("abort", onAbort, { once: true });
    const settle = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    // The lock promise is resolved unconditionally by release().
    previous.then(settle, settle);
  });
}

async function withYouTubeWriteLocks(youtube, keys, signal, operation) {
  let byKey = youtubeWriteLocks.get(youtube);
  if (!byKey) {
    byKey = new Map();
    youtubeWriteLocks.set(youtube, byKey);
  }

  async function run(index) {
    if (index === keys.length) return operation();
    const key = keys[index];
    const previous = byKey.get(key);
    let release;
    const released = new Promise((resolve) => { release = resolve; });
    // Cancelling a waiter releases its own slot promptly, but the queued
    // ownership chain must still wait for the earlier writer to finish.
    const current = previous ? previous.then(() => released) : released;
    byKey.set(key, current);

    try {
      if (previous) await waitForWriteLock(previous, signal);
      if (signal?.aborted) throw callerCancelled("YouTube write");
      return await run(index + 1);
    } finally {
      release();
      void current.then(() => {
        if (byKey.get(key) === current) byKey.delete(key);
      });
    }
  }

  return run(0);
}

export async function saveMusic({ youtube, library }, args = {}, { signal } = {}) {
  const input = args.input;
  const mode = args.mode === "apply" ? "apply" : "preview";
  const syncToYouTube = args.syncToYouTube !== false;
  const remoteDedupe = args.remoteDedupe === "source" ? "source" : "canonical";
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
  // When the input canonicalizes onto an existing track, that track's other
  // YouTube sources may already represent the song in the target playlist.
  // Under the default "canonical" remote dedupe policy both those sibling
  // sources and same-canonical-key playlist items count as membership;
  // "source" only skips the same videoId.
  let siblingVideoIds = [];
  let siblingSourcesError = null;
  if (syncToYouTube && remoteDedupe === "canonical" && identityDecision?.matchedTrackId != null) {
    try {
      siblingVideoIds = library
        .listTrackSources(identityDecision.matchedTrackId)
        .filter((source) => source.provider === "youtube" && source.sourceId !== video.id)
        .map((source) => source.sourceId);
    } catch (error) {
      // A failed source lookup must not silently weaken the dedupe decision —
      // remote canonical-key evidence still applies, and the receipt reports
      // the degraded lookup.
      siblingSourcesError = {
        code: error?.code ?? "DEDUPE_LOOKUP_FAILED",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
  const runProviderStep = () => runYouTubeStep(youtube, {
    video,
    targetReference,
    selectedCategory,
    mode,
    signal,
    completedSteps,
    remoteDedupe,
    siblingVideoIds,
    canonicalKey: canonicalData.canonicalKey,
    siblingSourcesError,
  });
  const youtubeStep = !syncToYouTube
    ? { enabled: false, action: "disabled", writeState: "NOT_REQUESTED" }
    : mode === "apply"
      ? await withYouTubeWriteLocks(youtube, writeLockKeys({
        videoId: video.id,
        canonicalKey: canonicalData.canonicalKey,
        remoteDedupe,
        targetReference,
      }), signal, runProviderStep)
      : await runProviderStep();

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

  if (mode === "apply" && libraryStep.writeState === "SAVED"
    && youtubeStep.action === "skipped_canonical_duplicate") {
    const matched = youtubeStep.existingItem;
    try {
      const linked = library.attachCanonicalSource(libraryStep.trackId, {
        provider: "youtube",
        sourceId: youtubeStep.matchedVideoId,
        title: matched?.name,
        channelTitle: matched?.channel,
        url: matched?.url ?? youtubeVideoUrl(youtubeStep.matchedVideoId),
      });
      libraryStep.remoteSource = {
        action: linked.action,
        sourceId: youtubeStep.matchedVideoId,
      };
      if (linked.action === "linked") completedSteps.push("canonical_remote_source_linked");
    } catch (error) {
      libraryStep.remoteSource = {
        action: "failed",
        sourceId: youtubeStep.matchedVideoId,
        error: errorInfo(error),
      };
    }
  }

  const libraryOk = libraryStep.writeState === "SAVED";
  const sourceLinkFailed = libraryStep.remoteSource?.action === "failed";
  const youtubeSkipped = ["skipped_duplicate", "skipped_canonical_duplicate"]
    .includes(youtubeStep.action);
  const youtubeOk = !syncToYouTube
    || youtubeStep.action === "added"
    || youtubeSkipped;
  const youtubeAmbiguous = syncToYouTube
    && ["UNKNOWN_AFTER_WRITE", "PARTIAL_PLAYLIST_CREATED"].includes(youtubeStep.writeState);

  let action;
  if (mode === "preview") {
    action = identity?.level === "EXACT_SOURCE_DUPLICATE" && youtubeStep.duplicate
      ? "would_skip_duplicate"
      : "would_save";
  } else if (sourceLinkFailed) {
    action = "reconciliation_required";
  } else if (libraryOk && youtubeOk) {
    action = youtubeSkipped && libraryStep.action === "existing"
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
  } else if (sourceLinkFailed) {
    syncState = "partial";
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
  } else if (sourceLinkFailed) {
    nextStep = "The playlist contains the matched video, but its source could not be linked to the local track. Inspect the exact video ID and track identity, then reconcile before pushing library changes to this playlist.";
  } else if (mode === "apply" && !libraryOk) {
    nextStep = "The local library write failed; re-run the same save_music call after fixing the library error — the YouTube side is deduplicated and the retry is idempotent.";
  } else if (mode === "apply" && syncToYouTube && !youtubeOk) {
    nextStep = youtubeStep.nextStep
      ?? "The YouTube write failed before any confirmed change; the track is saved in the local library — fix the reported error and re-run the same call.";
  }
  if (identity?.level === "POSSIBLE_MATCH" && action !== "reconciliation_required") {
    const stored = mode === "preview" ? "would be stored" : "was stored";
    nextStep = (nextStep ? nextStep + " " : "")
      + `The track ${stored} as a possible duplicate (needs_review); inspect the identity review queue and merge or split if it is the same song.`;
  }
  if (!nextStep && youtubeStep.action === "skipped_canonical_duplicate") {
    nextStep = youtubeStep.nextStep;
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
      youtubePlaylistItemKind: youtubeStep.duplicateKind ?? null,
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

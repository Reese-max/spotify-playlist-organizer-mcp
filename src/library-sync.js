// library-sync: inspectable, previewable, recoverable sync between the local
// Personal Music Library and YouTube playlists. sync_status is read-only;
// sync_youtube separates push / pull / reconcile semantics and only executes
// what preview authorized; reconcile_track resolves uncertain writes by
// exact-ID read-back instead of blind retry. Exact playlist/video IDs are the
// stable identifiers — display names are never used as keys.

import { LibraryError } from "./library.js";
import { parseYouTubePlaylistReference, youtubeVideoUrl } from "./youtube.js";

const SYNC_PREFIX = "sync.";
const UNKNOWN_STATES = new Set(["unknown", "unknown_after_write"]);

function syncKey(trackId) {
  return `${SYNC_PREFIX}${trackId}`;
}

function errorInfo(error) {
  return {
    code: error?.code ?? "PROVIDER_ERROR",
    message: error instanceof Error ? error.message : String(error),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  };
}

// Same ambiguity rule as save_music / remove_music.
function isAmbiguousWriteError(error) {
  return ["TIMEOUT", "CALLER_CANCELLED", "NETWORK_ERROR"].includes(error?.code)
    || error?.status === 429
    || error?.status >= 500;
}

function readMarker(library, trackId) {
  const raw = library.getSyncState(syncKey(trackId));
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeMarker(library, trackId, marker) {
  library.setSyncState(syncKey(trackId), {
    ...marker,
    updatedAt: new Date().toISOString(),
  });
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

// YouTube keeps deleted/private entries in playlistItems with sentinel titles.
function isUnavailableRemoteItem(item) {
  const name = String(item?.name ?? "").trim().toLowerCase();
  return item?.status === "private" || name === "deleted video" || name === "private video";
}

function allLibraryTracks(library) {
  const tracks = [];
  let offset = 0;
  while (true) {
    const page = library.listTracks({ limit: 100, offset });
    tracks.push(...page.items);
    if (page.items.length < 100) break;
    offset += page.items.length;
  }
  return tracks;
}

function youtubeVideoIds(library, trackId) {
  return library
    .listTrackSources(trackId)
    .filter((source) => source.provider === "youtube")
    .map((source) => source.sourceId);
}

// Read-only diff between the library and the managed YouTube playlists.
async function scanSync({ library, youtube }, { playlist, signal } = {}) {
  let scopeId = null;
  if (playlist) {
    const parsed = parseYouTubePlaylistReference(playlist);
    if (!parsed.id) {
      throw new LibraryError(
        "LIBRARY_INPUT_INVALID",
        "playlist must be an exact playlist ID or URL, not a name.",
      );
    }
    scopeId = parsed.id;
  }

  const records = library
    .listManagedPlaylists("youtube")
    .filter((record) => !scopeId || record.playlistId === scopeId);

  const playlists = [];
  const playlistItems = new Map(); // playlistId -> items[] | null (read failed)
  const readErrors = [];
  for (const record of records) {
    try {
      const [remote, items] = await Promise.all([
        youtube.getPlaylist(record.playlistId, { signal }),
        youtube.getPlaylistItems(record.playlistId, { signal }),
      ]);
      playlistItems.set(record.playlistId, items);
      playlists.push({
        playlistId: record.playlistId,
        name: record.name,
        remoteName: remote.name ?? record.name,
        renamed: Boolean(remote.name && record.name && remote.name !== record.name),
        itemCount: items.length,
      });
    } catch (error) {
      playlistItems.set(record.playlistId, null);
      playlists.push({
        playlistId: record.playlistId,
        name: record.name,
        remoteName: null,
        renamed: false,
        itemCount: null,
        error: errorInfo(error),
      });
      readErrors.push({ playlistId: record.playlistId, error: errorInfo(error) });
    }
  }

  const recordById = new Map(records.map((record) => [record.playlistId, record]));
  const tracks = [];
  const videos = [];

  for (const track of allLibraryTracks(library)) {
    const videoIds = youtubeVideoIds(library, track.id);
    if (!videoIds.length) continue;
    const marker = readMarker(library, track.id);
    const links = library
      .listTrackPlaylists(track.id)
      .filter((entry) => entry.provider === "youtube" && entry.playlistId)
      .filter((entry) => !scopeId || entry.playlistId === scopeId);
    const linked = links.filter((entry) => recordById.has(entry.playlistId));

    const statusFor = (presentIds, readFailed) => {
      if (track.needsReview) return "conflict";
      if (marker && UNKNOWN_STATES.has(marker.state)) return "unknown_after_write";
      if (readFailed) return "unknown";
      return presentIds.length ? "in_sync" : "local_only";
    };

    if (!linked.length) {
      tracks.push({
        trackId: track.id,
        title: track.canonicalTitle,
        playlistId: null,
        videoIds,
        presentVideoIds: [],
        status: track.needsReview
          ? "conflict"
          : marker && UNKNOWN_STATES.has(marker.state)
            ? "unknown_after_write"
            : "local_only",
        reason: "no_managed_playlist",
      });
      continue;
    }

    for (const link of linked) {
      const items = playlistItems.get(link.playlistId);
      const present = items === null
        ? []
        : videoIds.filter((id) => items.some((item) => item.id === id));
      tracks.push({
        trackId: track.id,
        title: track.canonicalTitle,
        playlistId: link.playlistId,
        videoIds,
        presentVideoIds: present,
        status: statusFor(present, items === null),
      });
    }
  }

  // Remote-side view: items whose videoId has no local source, or whose local
  // track is not linked to this playlist, or that YouTube reports as gone.
  for (const [playlistId, items] of playlistItems) {
    if (items === null) continue;
    for (const item of items) {
      if (!item.id) continue;
      const localTrack = library.getTrackBySource("youtube", item.id);
      if (isUnavailableRemoteItem(item)) {
        videos.push({
          playlistId,
          videoId: item.id,
          name: item.name,
          status: "unavailable",
          trackId: localTrack?.id ?? null,
        });
        continue;
      }
      if (!localTrack) {
        videos.push({ playlistId, videoId: item.id, name: item.name, status: "youtube_only" });
        continue;
      }
      const linkedHere = library
        .listTrackPlaylists(localTrack.id)
        .some((entry) => entry.provider === "youtube" && entry.playlistId === playlistId);
      if (!linkedHere) {
        videos.push({
          playlistId,
          videoId: item.id,
          name: item.name,
          status: "unlinked",
          trackId: localTrack.id,
        });
      }
    }
  }

  return { scope: scopeId ?? "all", playlists, tracks, videos, readErrors };
}

function summarize(scan) {
  const summary = {
    in_sync: 0,
    local_only: 0,
    youtube_only: 0,
    unavailable: 0,
    conflict: 0,
    unknown_after_write: 0,
    unknown: 0,
  };
  for (const entry of scan.tracks) {
    if (entry.status in summary) summary[entry.status] += 1;
  }
  for (const video of scan.videos) {
    if (video.status in summary) summary[video.status] += 1;
  }
  return summary;
}

export async function syncStatus({ library, youtube }, args = {}, { signal } = {}) {
  const scan = await scanSync({ library, youtube }, { playlist: args.playlist, signal });
  return { mode: "status", ...scan, summary: summarize(scan) };
}

// Build the plan a given direction would execute. Pure derivation from the
// scan — apply executes exactly this.
function buildPlan(scan, direction, { allowRemoval = false } = {}) {
  const plan = {
    additions: [],
    imports: [],
    removals: [],
    renames: [],
    links: [],
    sourceMarks: [],
    markerResolutions: [],
  };

  if (direction === "push") {
    for (const entry of scan.tracks) {
      if (entry.status !== "local_only" || !entry.playlistId) continue;
      for (const videoId of entry.videoIds) {
        if (!entry.presentVideoIds.includes(videoId)) {
          plan.additions.push({
            trackId: entry.trackId,
            playlistId: entry.playlistId,
            videoId,
          });
        }
      }
    }
    if (allowRemoval) {
      for (const video of scan.videos) {
        if (video.status === "youtube_only") {
          plan.removals.push({ playlistId: video.playlistId, videoId: video.videoId, name: video.name });
        }
      }
    }
  }

  if (direction === "pull") {
    for (const video of scan.videos) {
      if (video.status === "youtube_only") {
        plan.imports.push({ playlistId: video.playlistId, videoId: video.videoId, name: video.name });
      }
    }
  }

  if (direction === "reconcile") {
    for (const playlist of scan.playlists) {
      if (playlist.renamed && !playlist.error) {
        plan.renames.push({
          playlistId: playlist.playlistId,
          from: playlist.name,
          to: playlist.remoteName,
        });
      }
    }
    for (const video of scan.videos) {
      if (video.status === "unavailable" && video.trackId) {
        plan.sourceMarks.push({ trackId: video.trackId, videoId: video.videoId, status: "unavailable" });
      }
      if (video.status === "unlinked" && video.trackId) {
        plan.links.push({ trackId: video.trackId, playlistId: video.playlistId, videoId: video.videoId });
      }
    }
    // Unknown writes resolve by exact-ID read-back against the scanned items:
    // the video either is in the playlist (synced) or is not (local_only).
    const itemsByPlaylist = new Map(
      scan.playlists.filter((p) => !p.error).map((p) => [p.playlistId, p]),
    );
    for (const entry of scan.tracks) {
      if (entry.status !== "unknown_after_write" || !entry.playlistId) continue;
      if (!itemsByPlaylist.has(entry.playlistId)) continue;
      plan.markerResolutions.push({
        trackId: entry.trackId,
        playlistId: entry.playlistId,
        to: entry.presentVideoIds.length ? "synced" : "local_only",
      });
    }
  }

  return plan;
}

export async function syncYoutube({ library, youtube }, args = {}, { signal } = {}) {
  const mode = args.mode === "apply" ? "apply" : "preview";
  const direction = args.direction ?? "push";
  if (!["push", "pull", "reconcile"].includes(direction)) {
    throw new LibraryError(
      "LIBRARY_INPUT_INVALID",
      "direction must be one of: push, pull, reconcile.",
    );
  }
  const allowRemoval = args.allowRemoval === true;

  const scan = await scanSync({ library, youtube }, { playlist: args.playlist, signal });
  const plan = buildPlan(scan, direction, { allowRemoval });

  if (mode === "preview") {
    return {
      mode,
      action: "preview",
      direction,
      scope: scan.scope,
      plan,
      summary: summarize(scan),
      readErrors: scan.readErrors,
      nextStep: "Re-run with mode \"apply\" and the same direction/scope to execute this plan.",
    };
  }

  const results = {
    added: [],
    imported: [],
    removed: [],
    renamed: [],
    linked: [],
    marked: [],
    resolved: [],
    failures: [],
  };
  let ambiguous = false;

  for (const rename of plan.renames) {
    try {
      library.updatePlaylistName("youtube", rename.playlistId, rename.to);
      results.renamed.push(rename);
    } catch (error) {
      results.failures.push({ step: "rename", ...rename, error: errorInfo(error) });
    }
  }

  for (const mark of plan.sourceMarks) {
    try {
      library.setSourceStatus("youtube", mark.videoId, mark.status);
      writeMarker(library, mark.trackId, {
        state: "unavailable",
        playlistId: null,
        videoId: mark.videoId,
      });
      results.marked.push(mark);
    } catch (error) {
      results.failures.push({ step: "mark_source", ...mark, error: errorInfo(error) });
    }
  }

  for (const link of plan.links) {
    try {
      const playlist = scan.playlists.find((p) => p.playlistId === link.playlistId);
      library.attachPlaylist(link.trackId, {
        provider: "youtube",
        playlistId: link.playlistId,
        name: playlist?.remoteName ?? playlist?.name ?? null,
      });
      results.linked.push(link);
    } catch (error) {
      results.failures.push({ step: "link", ...link, error: errorInfo(error) });
    }
  }

  for (const resolution of plan.markerResolutions) {
    try {
      writeMarker(library, resolution.trackId, {
        state: resolution.to,
        playlistId: resolution.playlistId,
        videoId: null,
      });
      results.resolved.push(resolution);
    } catch (error) {
      results.failures.push({ step: "resolve_marker", ...resolution, error: errorInfo(error) });
    }
  }

  for (const addition of plan.additions) {
    try {
      await youtube.addVideoToPlaylist(addition.playlistId, addition.videoId, { signal });
      writeMarker(library, addition.trackId, {
        state: "synced",
        playlistId: addition.playlistId,
        videoId: addition.videoId,
      });
      results.added.push(addition);
    } catch (error) {
      if (isAmbiguousWriteError(error)) {
        ambiguous = true;
        writeMarker(library, addition.trackId, {
          state: "unknown_after_write",
          playlistId: addition.playlistId,
          videoId: addition.videoId,
        });
      }
      results.failures.push({
        step: "add",
        ...addition,
        writeState: isAmbiguousWriteError(error)
          ? "UNKNOWN_AFTER_WRITE"
          : "FAILED_NO_CONFIRMED_EFFECT",
        error: errorInfo(error),
      });
    }
  }

  for (const item of plan.imports) {
    try {
      const playlist = scan.playlists.find((p) => p.playlistId === item.playlistId);
      const saved = library.upsertTrack({
        title: item.name ?? item.videoId,
        source: {
          provider: "youtube",
          sourceId: item.videoId,
          url: youtubeVideoUrl(item.videoId),
        },
        playlist: {
          provider: "youtube",
          playlistId: item.playlistId,
          name: playlist?.remoteName ?? playlist?.name ?? null,
        },
      });
      writeMarker(library, saved.track.id, {
        state: "synced",
        playlistId: item.playlistId,
        videoId: item.videoId,
      });
      results.imported.push({ ...item, trackId: saved.track.id, created: saved.created });
    } catch (error) {
      results.failures.push({ step: "import", ...item, error: errorInfo(error) });
    }
  }

  for (const removal of plan.removals) {
    try {
      const outcome = await youtube.removeVideoFromPlaylist(removal.playlistId, removal.videoId, { signal });
      results.removed.push({ ...removal, removed: outcome.removed !== false });
    } catch (error) {
      if (isAmbiguousWriteError(error)) ambiguous = true;
      results.failures.push({
        step: "remove",
        ...removal,
        writeState: isAmbiguousWriteError(error)
          ? "UNKNOWN_AFTER_WRITE"
          : "FAILED_NO_CONFIRMED_EFFECT",
        error: errorInfo(error),
      });
    }
  }

  const action = ambiguous
    ? "reconciliation_required"
    : results.failures.length
      ? "partial_failure"
      : "synced";

  return {
    mode,
    action,
    direction,
    scope: scan.scope,
    plan,
    results,
    summary: summarize(scan),
    readErrors: scan.readErrors,
    ...(ambiguous
      ? { nextStep: "Run reconcile_track (or direction \"reconcile\") to resolve each unknown_after_write by exact-ID read-back; do not retry blindly." }
      : results.failures.length
        ? { nextStep: "Fix each reported failure and re-run the same sync_youtube call; completed effects are idempotent." }
        : {}),
  };
}

// reconcile_track: exact-ID read-back for one track (or one videoId +
// playlistId pair). Resolves unknown_after_write markers and source
// availability without deleting the canonical track.
export async function reconcileTrack({ library, youtube }, args = {}, { signal } = {}) {
  let track;
  if (args.trackId !== undefined) {
    track = requireTrack(library, args.trackId);
  } else if (args.videoId) {
    track = library.getTrackBySource("youtube", args.videoId);
    if (!track) {
      throw new LibraryError(
        "LIBRARY_INPUT_INVALID",
        `No library track owns youtube:${args.videoId}.`,
      );
    }
  } else {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "trackId or videoId is required.");
  }

  const prior = readMarker(library, track.id);
  const resolvedFrom = prior && UNKNOWN_STATES.has(prior.state) ? prior.state : null;

  const sources = library
    .listTrackSources(track.id)
    .filter((source) => source.provider === "youtube");
  const sourceReports = [];
  for (const source of sources) {
    try {
      await youtube.getVideo(source.sourceId, { signal });
      if (source.status !== "ok") library.setSourceStatus("youtube", source.sourceId, "ok");
      sourceReports.push({ sourceId: source.sourceId, status: "ok" });
    } catch (error) {
      library.setSourceStatus("youtube", source.sourceId, "unavailable");
      sourceReports.push({ sourceId: source.sourceId, status: "unavailable", error: errorInfo(error) });
    }
  }

  const links = library
    .listTrackPlaylists(track.id)
    .filter((entry) => entry.provider === "youtube" && entry.playlistId)
    .filter((entry) => !args.playlistId || entry.playlistId === args.playlistId);
  const presence = [];
  for (const link of links) {
    try {
      const items = await youtube.getPlaylistItems(link.playlistId, { signal });
      const presentIds = sources
        .map((source) => source.sourceId)
        .filter((id) => items.some((item) => item.id === id));
      for (const source of sources) {
        presence.push({
          playlistId: link.playlistId,
          videoId: source.sourceId,
          present: presentIds.includes(source.sourceId),
        });
      }
    } catch (error) {
      presence.push({ playlistId: link.playlistId, error: errorInfo(error) });
    }
  }

  const anyPresent = presence.some((entry) => entry.present === true);
  const allUnavailable = sources.length > 0 && sourceReports.every((report) => report.status === "unavailable");
  const state = anyPresent
    ? "synced"
    : allUnavailable
      ? "unavailable"
      : "local_only";
  const marker = {
    state,
    playlistId: presence.find((entry) => entry.present)?.playlistId
      ?? prior?.playlistId
      ?? links[0]?.playlistId
      ?? null,
    videoId: prior?.videoId ?? sources[0]?.sourceId ?? null,
  };
  writeMarker(library, track.id, marker);

  return {
    trackId: track.id,
    track,
    resolvedFrom,
    sources: sourceReports,
    presence,
    sync: { ...marker, updatedAt: new Date().toISOString() },
  };
}

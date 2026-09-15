// batch-import: bring existing YouTube / YouTube Music collections into the
// Personal Music Library in one pass. Pipeline: parse → resolve →
// canonicalize → dedupe → preview plan → apply → optional YouTube sync.
// Every item gets its own result — one bad link never rolls back the batch,
// and unresolved input is reported rather than silently dropped. Plans are
// persisted under `import.<batchId>` sync_state keys so apply only touches
// what preview resolved and cancelled batches can resume.

import crypto from "node:crypto";

import { parseLink } from "./core.js";
import { LibraryError } from "./library.js";
import {
  parseYouTubePlaylistReference,
  youtubeVideoUrl,
} from "./youtube.js";

const IMPORT_PREFIX = "import.";
const CHUNK_SIZE = 25;
const MAX_DETAIL_ITEMS = 500;
const UNAVAILABLE_TITLES = new Set(["deleted video", "private video"]);

function errorInfo(error) {
  return {
    code: error?.code ?? "PROVIDER_ERROR",
    message: error instanceof Error ? error.message : String(error),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  };
}

function isUnavailableName(name) {
  return UNAVAILABLE_TITLES.has(String(name ?? "").trim().toLowerCase());
}

function loadPlan(library, batchId) {
  const raw = library.getSyncState(`${IMPORT_PREFIX}${batchId}`);
  if (typeof raw !== "string" || !raw) return null;
  try {
    const plan = JSON.parse(raw);
    return Array.isArray(plan?.items) ? plan : null;
  } catch {
    return null;
  }
}

function storePlan(library, plan) {
  library.setSyncState(`${IMPORT_PREFIX}${plan.batchId}`, plan);
}

function computeBatchId(args) {
  const fingerprint = {
    items: [...(args.items ?? [])].map((item) => String(item).trim()).filter(Boolean).sort(),
    playlist: args.playlistId ?? null,
    sync: args.syncPlaylistId ?? null,
  };
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(fingerprint))
    .digest("hex")
    .slice(0, 24);
}

function countBy(items) {
  const counts = {
    total: items.length,
    new: 0,
    exactDuplicate: 0,
    canonicalDuplicate: 0,
    unresolved: 0,
    unavailable: 0,
  };
  for (const item of items) {
    if (item.status === "new") counts.new += 1;
    else if (item.status === "exact_duplicate") counts.exactDuplicate += 1;
    else if (item.status === "canonical_duplicate") counts.canonicalDuplicate += 1;
    else if (item.status === "unresolved") counts.unresolved += 1;
    else if (item.status === "unavailable") counts.unavailable += 1;
  }
  return counts;
}

// Classify a resolved videoId against the library: exact source duplicate,
// canonical duplicate (merge/needs-review), or genuinely new.
function dedupeItem(library, item) {
  const existing = library.getTrackBySource("youtube", item.videoId);
  if (existing) {
    return { ...item, status: "exact_duplicate", trackId: existing.id };
  }
  try {
    const identity = library.previewIdentity({
      title: item.title,
      artist: item.artist,
      source: {
        provider: "youtube",
        sourceId: item.videoId,
        channelTitle: item.channel,
      },
    });
    const state = identity?.decision?.state;
    if (state === "existing") {
      return { ...item, status: "exact_duplicate", trackId: identity.decision.matchedTrackId };
    }
    if (state === "same_canonical" || state === "possible_match") {
      return {
        ...item,
        status: "canonical_duplicate",
        trackId: identity.decision.matchedTrackId ?? null,
        needsReview: state === "possible_match",
      };
    }
  } catch {
    // Identity preview failure must not block the import — treat as new.
  }
  return { ...item, status: "new" };
}

async function resolvePlan({ library, youtube }, args, { signal } = {}) {
  const rawItems = (args.items ?? []).map((item) => String(item).trim()).filter(Boolean);

  let playlistId = null;
  let playlistName = null;
  if (args.playlist) {
    const parsed = parseYouTubePlaylistReference(args.playlist);
    if (!parsed.id) {
      throw new LibraryError(
        "LIBRARY_INPUT_INVALID",
        "playlist must be an exact YouTube playlist ID or URL, not a name.",
      );
    }
    playlistId = parsed.id;
    const details = await youtube.getPlaylist(playlistId, { signal });
    playlistName = details?.name ?? null;
  }

  let syncPlaylistId = null;
  if (args.syncPlaylist) {
    const parsed = parseYouTubePlaylistReference(args.syncPlaylist);
    if (!parsed.id) {
      throw new LibraryError(
        "LIBRARY_INPUT_INVALID",
        "syncPlaylist must be an exact YouTube playlist ID or URL, not a name.",
      );
    }
    syncPlaylistId = parsed.id;
  }

  const items = [];
  const seen = new Set();
  const push = (item) => {
    if (item.videoId && seen.has(item.videoId)) {
      items.push({ ...item, status: "exact_duplicate", inBatchDuplicate: true });
      return;
    }
    if (item.videoId) seen.add(item.videoId);
    items.push(item);
  };

  for (const input of rawItems) {
    const link = parseLink(input);
    let videoId = null;
    let resolvedBy = null;
    if (link.kind === "youtube-video") {
      videoId = link.id;
      resolvedBy = "url";
    } else if (/^[A-Za-z0-9_-]{11}$/.test(input)) {
      videoId = input;
      resolvedBy = "id";
    }
    if (videoId) {
      try {
        const video = await youtube.getVideo(videoId, { signal });
        push(dedupeItem(library, {
          input,
          videoId,
          title: video.name ?? videoId,
          artist: video.channel ?? null,
          channel: video.channel ?? null,
          resolvedBy,
        }));
      } catch (error) {
        push({ input, videoId, resolvedBy, status: "unavailable", error: errorInfo(error) });
      }
      continue;
    }
    // Free text: resolve through search, top candidate only, marked as such.
    try {
      const search = await youtube.searchVideos(input, { limit: 1, signal });
      const hit = search.videos?.[0];
      if (!hit?.id) {
        push({ input, status: "unresolved" });
        continue;
      }
      push(dedupeItem(library, {
        input,
        videoId: hit.id,
        title: hit.name ?? hit.id,
        artist: hit.channel ?? null,
        channel: hit.channel ?? null,
        resolvedBy: "search",
      }));
    } catch (error) {
      push({ input, status: "unresolved", error: errorInfo(error) });
    }
  }

  if (playlistId) {
    const remote = await youtube.getPlaylistItems(playlistId, { signal });
    for (const entry of remote) {
      if (!entry.id) continue;
      if (isUnavailableName(entry.name)) {
        push({ input: `${playlistId}:${entry.id}`, videoId: entry.id, resolvedBy: "playlist", status: "unavailable" });
        continue;
      }
      push(dedupeItem(library, {
        input: `${playlistId}:${entry.id}`,
        videoId: entry.id,
        title: entry.name ?? entry.id,
        resolvedBy: "playlist",
        sourcePlaylistId: playlistId,
      }));
    }
  }

  return {
    batchId: computeBatchId({ items: rawItems, playlistId, syncPlaylistId }),
    playlistId,
    playlistName,
    syncPlaylistId,
    items,
    createdAt: new Date().toISOString(),
  };
}

function publicItems(plan) {
  const truncated = plan.items.length > MAX_DETAIL_ITEMS;
  const items = (truncated ? plan.items.slice(0, MAX_DETAIL_ITEMS) : plan.items)
    .map(({ input, videoId, title, status, resolvedBy, trackId, needsReview, result, inBatchDuplicate }) => ({
      input,
      ...(videoId ? { videoId } : {}),
      ...(title ? { title } : {}),
      status,
      ...(resolvedBy ? { resolvedBy } : {}),
      ...(trackId ? { trackId } : {}),
      ...(needsReview ? { needsReview: true } : {}),
      ...(inBatchDuplicate ? { inBatchDuplicate: true } : {}),
      ...(result ? { result } : {}),
    }));
  return { items, truncated };
}

export async function previewImport({ library, youtube }, args = {}, { signal } = {}) {
  const plan = await resolvePlan({ library, youtube }, args, { signal });
  storePlan(library, plan);

  let sync = null;
  if (plan.syncPlaylistId) {
    const existing = new Set(
      (await youtube.getPlaylistItems(plan.syncPlaylistId, { signal })).map((item) => item.id),
    );
    sync = {
      playlistId: plan.syncPlaylistId,
      additions: plan.items.filter(
        (item) => item.videoId && (item.status === "new" || item.status === "canonical_duplicate") && !existing.has(item.videoId),
      ).length,
    };
  }

  return {
    mode: "preview",
    batchId: plan.batchId,
    playlist: plan.playlistId ? { playlistId: plan.playlistId, name: plan.playlistName } : null,
    counts: countBy(plan.items),
    sync,
    ...publicItems(plan),
  };
}

export function importStatus(library, args = {}) {
  const batchId = typeof args.batchId === "string" ? args.batchId.trim() : null;
  if (!batchId) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "batchId is required.");
  }
  const plan = loadPlan(library, batchId);
  if (!plan) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", `No import batch ${batchId} is stored.`);
  }
  const done = plan.items.filter((item) => item.result != null).length;
  return {
    batchId,
    createdAt: plan.createdAt,
    playlistId: plan.playlistId,
    counts: countBy(plan.items),
    done,
    pending: plan.items.length - done,
  };
}

export async function importMusicBatch({ library, youtube }, args = {}, { signal } = {}) {
  let plan = null;
  if (args.batchId) {
    plan = loadPlan(library, args.batchId);
    if (!plan) {
      throw new LibraryError("LIBRARY_INPUT_INVALID", `No import batch ${args.batchId} is stored.`);
    }
  }
  if (!plan || (!args.batchId && (args.items?.length || args.playlist))) {
    plan = await resolvePlan({ library, youtube }, args, { signal });
  }
  // The stored plan may remember a previewed sync target, but apply only
  // writes to YouTube when the caller explicitly opts in for THIS call.
  let syncTarget = null;
  if (args.syncPlaylist) {
    const parsed = parseYouTubePlaylistReference(args.syncPlaylist);
    if (!parsed.id) {
      throw new LibraryError(
        "LIBRARY_INPUT_INVALID",
        "syncPlaylist must be an exact YouTube playlist ID or URL, not a name.",
      );
    }
    syncTarget = parsed.id;
  }
  storePlan(library, plan);

  const results = [];
  let cancelled = false;
  let processed = 0;

  const flush = () => {
    storePlan(library, plan);
  };

  for (const item of plan.items) {
    if (item.result != null) continue; // already applied in a previous run
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    processed += 1;
    try {
      if (item.status === "unresolved") {
        item.result = "unresolved";
      } else if (item.status === "unavailable") {
        item.result = "unavailable";
      } else if (item.status === "exact_duplicate") {
        item.result = "exact_duplicate";
      } else {
        // Read-back before writing: the video may have died since preview.
        try {
          await youtube.getVideo(item.videoId, { signal });
        } catch {
          item.status = "unavailable";
          item.result = "unavailable";
          results.push({ input: item.input, videoId: item.videoId, status: "unavailable" });
          continue;
        }
        const saved = library.upsertTrack({
          title: item.title,
          artist: item.artist ?? undefined,
          source: {
            provider: "youtube",
            sourceId: item.videoId,
            url: youtubeVideoUrl(item.videoId),
          },
          ...(item.sourcePlaylistId
            ? { playlist: { provider: "youtube", playlistId: item.sourcePlaylistId, name: plan.playlistName } }
            : {}),
        });
        const state = saved.identity?.state;
        item.trackId = saved.track.id;
        item.result = state === "existing"
          ? "exact_duplicate"
          : state === "same_canonical"
            ? "canonical_duplicate"
            : state === "possible_match"
              ? "review"
              : "imported";
        library.setSyncState(`sync.${saved.track.id}`, {
          state: item.sourcePlaylistId ? "synced" : "local_only",
          playlistId: item.sourcePlaylistId ?? null,
          videoId: item.videoId,
          updatedAt: new Date().toISOString(),
        });
      }
    } catch (error) {
      item.result = "failed";
      item.error = errorInfo(error);
    }
    results.push({
      input: item.input,
      ...(item.videoId ? { videoId: item.videoId } : {}),
      ...(item.trackId ? { trackId: item.trackId } : {}),
      status: item.result,
      ...(item.error ? { error: item.error } : {}),
    });
    if (processed % CHUNK_SIZE === 0) flush();
  }
  flush();

  // Optional YouTube sync: only when the caller explicitly passed
  // syncPlaylist. Existing playlist members are never re-added.
  const syncResults = [];
  if (syncTarget && !cancelled) {
    let existing;
    try {
      existing = new Set(
        (await youtube.getPlaylistItems(syncTarget, { signal })).map((entry) => entry.id),
      );
    } catch (error) {
      results.push({ status: "sync_failed", error: errorInfo(error) });
      existing = null;
    }
    if (existing) {
      for (const item of plan.items) {
        if (signal?.aborted) { cancelled = true; break; }
        if (!item.videoId || existing.has(item.videoId)) continue;
        if (!["imported", "canonical_duplicate", "exact_duplicate", "review"].includes(item.result)) continue;
        try {
          await youtube.addVideoToPlaylist(syncTarget, item.videoId, { signal });
          syncResults.push({ videoId: item.videoId, trackId: item.trackId ?? null, status: "added" });
        } catch (error) {
          syncResults.push({ videoId: item.videoId, status: "failed", error: errorInfo(error) });
        }
      }
    }
  }

  const remaining = plan.items.filter((item) => item.result == null).length;
  const failed = results.filter((entry) => entry.status === "failed" || entry.status === "sync_failed").length;
  const action = cancelled
    ? "cancelled"
    : failed
      ? "partial_failure"
      : "imported";

  return {
    mode: "apply",
    action,
    batchId: plan.batchId,
    counts: countBy(plan.items),
    results,
    remaining,
    ...(syncTarget ? { sync: { playlistId: syncTarget, results: syncResults } } : {}),
    ...(cancelled
      ? { nextStep: `Re-run import_music_batch with batchId "${plan.batchId}" and resume:true to continue from item ${plan.items.length - remaining + 1}.` }
      : failed
        ? { nextStep: "Inspect each failed item in results; re-running the same batchId is idempotent." }
        : {}),
  };
}

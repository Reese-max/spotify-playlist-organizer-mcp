// batch-import: bring existing YouTube / YouTube Music collections into the
// Personal Music Library in one pass. Pipeline: parse → resolve →
// canonicalize → dedupe → preview plan → apply → optional YouTube sync.
// Every item gets its own result — one bad link never rolls back the batch,
// and unresolved input is reported rather than silently dropped. Plans are
// persisted under `import.<batchId>` sync_state keys so apply only touches
// what preview resolved and cancelled batches can resume; MCP receipts stay
// bounded (MAX_DETAIL_ITEMS) and import_status pages the stored plan, so a
// response lost to timeout/cancel can still be reconciled per item.

import crypto from "node:crypto";

import { parseLink } from "./core.js";
import { LibraryError, redactSecretishText } from "./library.js";
import {
  parseYouTubePlaylistReference,
  youtubeVideoUrl,
} from "./youtube.js";

const IMPORT_PREFIX = "import.";
const CHUNK_SIZE = 25;
const MAX_DETAIL_ITEMS = 500;
const STATUS_DEFAULT_LIMIT = 100;
const UNAVAILABLE_TITLES = new Set(["deleted video", "private video"]);

function errorInfo(error) {
  return {
    code: error?.code ?? "PROVIDER_ERROR",
    // Provider error text is untrusted and is persisted on the plan and read
    // back through import_status — strip credential-shaped substrings first.
    message: redactSecretishText(error instanceof Error ? error.message : String(error)),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  };
}

function addOutcomeUnknown(error) {
  // A client rejection is a definite failed add. A lost response, timeout,
  // throttling, or server error cannot prove whether the write landed.
  return ["TIMEOUT", "CALLER_CANCELLED", "NETWORK_ERROR", "UNKNOWN_AFTER_WRITE"].includes(error?.code)
    || [408, 429].includes(error?.status)
    || error?.status >= 500;
}

function isUnavailableName(name) {
  return UNAVAILABLE_TITLES.has(String(name ?? "").trim().toLowerCase());
}

function isConfirmedUnavailableVideo(video) {
  return video?.status === "private" || video?.status === "deleted";
}

function isConfirmedMissingError(error) {
  return error?.code === "NOT_FOUND" || error?.status === 404 || error?.status === 410;
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
    retryable: 0,
    unavailable: 0,
  };
  for (const item of items) {
    if (item.status === "new") counts.new += 1;
    else if (item.status === "exact_duplicate") counts.exactDuplicate += 1;
    else if (item.status === "canonical_duplicate") counts.canonicalDuplicate += 1;
    else if (item.status === "unresolved") counts.unresolved += 1;
    else if (item.status === "retryable") counts.retryable += 1;
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
  const firstById = new Map();
  const push = (item) => {
    // `input` is pasted free text persisted verbatim on the plan, so it is
    // untrusted on the same footing as a provider error message. Redact once
    // here, at the single construction point, so the stored plan, the preview,
    // the apply receipt and import_status all agree.
    const built = { ...item, input: redactSecretishText(item.input) };
    const first = built.videoId ? firstById.get(built.videoId) : null;
    if (first) {
      const status = first.status === "unavailable" ? "unavailable"
        : first.status === "retryable" ? "retryable" : "exact_duplicate";
      items.push({ ...built, status, inBatchDuplicate: true });
      return;
    }
    if (built.videoId) firstById.set(built.videoId, built);
    items.push(built);
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
      if (firstById.has(videoId)) {
        push({ input, videoId, resolvedBy });
        continue;
      }
      try {
        const video = await youtube.getVideo(videoId, { signal });
        if (isConfirmedUnavailableVideo(video)) {
          push({ input, videoId, resolvedBy, status: "unavailable" });
          continue;
        }
        push(dedupeItem(library, {
          input,
          videoId,
          title: video.name ?? videoId,
          artist: video.channel ?? null,
          channel: video.channel ?? null,
          resolvedBy,
        }));
      } catch (error) {
        const missing = isConfirmedMissingError(error);
        push({
          input,
          videoId,
          resolvedBy,
          status: missing ? "unavailable" : "retryable",
          ...(missing ? {} : { error: errorInfo(error) }),
        });
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
      if (isUnavailableName(entry.name) || isConfirmedUnavailableVideo(entry)) {
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

function publicError(error) {
  if (!error || typeof error !== "object") return error;
  return {
    ...error,
    // Plans written by a build without write-side redaction can still hold
    // provider text in the clear, so the read path redacts too.
    ...(typeof error.message === "string"
      ? { message: redactSecretishText(error.message) }
      : {}),
  };
}

function publicItem(item) {
  return {
    input: item.input,
    ...(item.videoId ? { videoId: item.videoId } : {}),
    ...(item.title ? { title: item.title } : {}),
    status: item.status,
    ...(item.resolvedBy ? { resolvedBy: item.resolvedBy } : {}),
    ...(item.trackId ? { trackId: item.trackId } : {}),
    ...(item.sourcePlaylistId ? { sourcePlaylistId: item.sourcePlaylistId } : {}),
    ...(item.needsReview ? { needsReview: true } : {}),
    ...(item.inBatchDuplicate ? { inBatchDuplicate: true } : {}),
    ...(item.result ? { result: item.result } : {}),
    ...(item.syncResult ? { syncResult: item.syncResult } : {}),
    ...(item.syncPlaylistId ? { syncPlaylistId: item.syncPlaylistId } : {}),
    ...(item.error ? { error: publicError(item.error) } : {}),
  };
}

function publicItems(plan) {
  const truncated = plan.items.length > MAX_DETAIL_ITEMS;
  const items = (truncated ? plan.items.slice(0, MAX_DETAIL_ITEMS) : plan.items)
    .map(publicItem);
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
  // Item detail is returned as a bounded page — a caller that lost the apply
  // response (timeout/cancel) can reconcile per-item outcomes from here.
  const offset = Math.max(0, Math.floor(Number(args.offset)) || 0);
  const rawLimit = Number(args.limit);
  const limit = Math.min(
    Math.max(Number.isFinite(rawLimit) ? Math.floor(rawLimit) : STATUS_DEFAULT_LIMIT, 1),
    MAX_DETAIL_ITEMS,
  );
  const nextOffset = offset + limit < plan.items.length ? offset + limit : null;
  return {
    batchId,
    createdAt: plan.createdAt,
    playlistId: plan.playlistId,
    counts: countBy(plan.items),
    done,
    pending: plan.items.length - done,
    items: plan.items.slice(offset, offset + limit).map(publicItem),
    itemsTotal: plan.items.length,
    itemsTruncated: nextOffset !== null,
    nextOffset,
    ...(plan.syncError ? { syncError: publicError(plan.syncError) } : {}),
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
  // The sync preflight error describes ONE apply attempt. A run that does not
  // opt into sync performs no sync attempt, so drop a previous run's failure
  // here instead of letting import_status report it as current. A run that DOES
  // opt in keeps the old value until its own preflight actually resolves it.
  if (!syncTarget) delete plan.syncError;
  storePlan(library, plan);

  const results = [];
  let cancelled = false;
  let processed = 0;
  const firstById = new Map();

  const flush = () => {
    storePlan(library, plan);
  };

  for (const item of plan.items) {
    const first = item.videoId ? firstById.get(item.videoId) : null;
    if (item.videoId && !first) firstById.set(item.videoId, item);
    if (item.result != null) continue; // already applied in a previous run
    if (signal?.aborted) {
      cancelled = true;
      break;
    }
    processed += 1;
    try {
      if (item.inBatchDuplicate) {
        if (first?.result === "unavailable") {
          item.status = "unavailable";
          item.result = "unavailable";
        } else if (first?.trackId && ["imported", "canonical_duplicate", "exact_duplicate", "review"].includes(first.result)) {
          item.status = "exact_duplicate";
          item.result = "exact_duplicate";
          item.trackId = first.trackId;
        } else if (first?.result === "failed") {
          item.result = "failed";
          item.error = first.error;
        } else {
          item.status = "retryable";
          results.push({ input: item.input, videoId: item.videoId, status: "retryable" });
          continue;
        }
      } else if (item.status === "unresolved") {
        item.result = "unresolved";
      } else if (item.status === "unavailable") {
        item.result = "unavailable";
      } else {
        // Read-back before writing: the video may have died since preview.
        try {
          const video = await youtube.getVideo(item.videoId, { signal });
          if (isConfirmedUnavailableVideo(video)) {
            item.status = "unavailable";
            item.result = "unavailable";
            delete item.error;
            results.push({ input: item.input, videoId: item.videoId, status: "unavailable" });
            continue;
          }
          if (item.status === "retryable") {
            item.title = video.name ?? item.videoId;
            item.artist = video.channel ?? null;
            item.status = "new";
          }
        } catch (error) {
          const missing = isConfirmedMissingError(error);
          if (missing) {
            item.status = "unavailable";
            item.result = "unavailable";
            delete item.error;
            results.push({ input: item.input, videoId: item.videoId, status: "unavailable" });
          } else {
            item.error = errorInfo(error);
            results.push({ input: item.input, videoId: item.videoId, status: "retryable", error: item.error });
            if (signal?.aborted) cancelled = true;
          }
          continue;
        }
        delete item.error;
        if (item.status === "exact_duplicate") {
          item.result = "exact_duplicate";
        } else {
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
  let syncPreflightError = null;
  if (syncTarget && !cancelled) {
    let existing;
    try {
      existing = new Set(
        (await youtube.getPlaylistItems(syncTarget, { signal })).map((entry) => entry.id),
      );
      // This attempt reached the provider, so any earlier preflight failure is
      // superseded by a real listing.
      delete plan.syncError;
    } catch (error) {
      // The listing failure is persisted on the plan, not just the receipt —
      // a truncated results window must not lose the only copy of why. It names
      // its target because a later cancelled run may retain it.
      syncPreflightError = { playlistId: syncTarget, ...errorInfo(error) };
      plan.syncError = syncPreflightError;
      existing = null;
    }
    if (existing) {
      const syncable = new Set(plan.items
        .filter((item) => !item.inBatchDuplicate && item.trackId
          && ["imported", "canonical_duplicate", "exact_duplicate", "review"].includes(item.result))
        .map((item) => item.videoId));
      const attempted = new Set();
      let syncProcessed = 0;
      for (const item of plan.items) {
        if (signal?.aborted) { cancelled = true; break; }
        if (!item.videoId || !syncable.has(item.videoId)) continue;
        if (existing.has(item.videoId)) {
          // No add is attempted, but the row must still record THIS run's
          // outcome. Otherwise an unknown_after_write (or a failure against a
          // previous target) would stay on the plan forever and never clear.
          if (item.syncResult !== "already_present" || item.syncPlaylistId !== syncTarget) {
            item.syncResult = "already_present";
            item.syncPlaylistId = syncTarget;
          }
          continue;
        }
        if (attempted.has(item.videoId)) continue;
        if (!["imported", "canonical_duplicate", "exact_duplicate", "review"].includes(item.result)) continue;
        attempted.add(item.videoId);
        try {
          await youtube.addVideoToPlaylist(syncTarget, item.videoId, { signal });
          item.syncResult = "added";
          item.syncPlaylistId = syncTarget;
          syncResults.push({ playlistId: syncTarget, videoId: item.videoId, trackId: item.trackId ?? null, status: "added" });
        } catch (error) {
          const unknown = addOutcomeUnknown(error);
          item.syncResult = unknown ? "unknown_after_write" : "failed";
          item.syncPlaylistId = syncTarget;
          syncResults.push({
            playlistId: syncTarget,
            videoId: item.videoId,
            status: item.syncResult,
            ...(unknown ? { writeState: "UNKNOWN_AFTER_WRITE" } : {}),
            error: errorInfo(error),
          });
        }
        syncProcessed += 1;
        if (syncProcessed % CHUNK_SIZE === 0) flush();
      }
      // In-batch duplicate rows share the primary's videoId — mirror the
      // outcome so every row reconciles identically through import_status. The
      // mirror is a refresh, not a fill: re-syncing the batch to another
      // playlist must not leave one row reporting the previous target.
      const syncByVideo = new Map();
      for (const item of plan.items) {
        // Only the primary row is a mirror source. A duplicate row still
        // carrying a previous run's syncResult must not shadow the primary.
        if (!item.inBatchDuplicate && item.videoId && item.syncResult) {
          syncByVideo.set(item.videoId, item);
        }
      }
      let mirrored = 0;
      for (const item of plan.items) {
        const primary = item.inBatchDuplicate && item.videoId ? syncByVideo.get(item.videoId) : null;
        if (!primary) continue;
        if (item.syncResult === primary.syncResult && item.syncPlaylistId === primary.syncPlaylistId) continue;
        item.syncResult = primary.syncResult;
        item.syncPlaylistId = primary.syncPlaylistId;
        // Flush on the same cadence as the add loop: a crash mid-batch must not
        // leave primaries corrected while their duplicates still hold stale
        // values from an earlier run.
        mirrored += 1;
        if (mirrored % CHUNK_SIZE === 0) flush();
      }
    }
    // Per-item sync outcomes live on the stored plan so a lost response can
    // still be reconciled through import_status.
    flush();
  }

  const remaining = plan.items.filter((item) => item.result == null).length;
  const syncFailed = syncResults.filter((entry) => entry.status === "failed").length;
  const syncUnknown = syncResults.filter((entry) => entry.status === "unknown_after_write");
  const failed = results.filter((entry) => ["failed", "retryable"].includes(entry.status)).length
    + syncFailed + (syncPreflightError ? 1 : 0);
  let action = "imported";
  if (failed) action = "partial_failure";
  if (cancelled) action = "cancelled";
  if (syncUnknown.length) action = "UNKNOWN_AFTER_WRITE";

  // Receipts are bounded — a large batch pages the rest through import_status.
  const resultsTruncated = results.length > MAX_DETAIL_ITEMS;
  const syncTruncated = syncResults.length > MAX_DETAIL_ITEMS;

  let nextStep;
  if (syncUnknown.length) {
    // The prose receipt is part of the same bounded response as results and
    // sync.results — never name an unbounded list of video IDs in it.
    const named = syncUnknown.slice(0, MAX_DETAIL_ITEMS);
    const extra = syncUnknown.length - named.length;
    nextStep = `Verify exact video IDs ${named.map((entry) => entry.videoId).join(", ")}`
      + `${extra > 0 ? ` and ${extra} more` : ""}`
      + ` in playlist ${syncTarget} before retrying any additions; the provider write may have succeeded.`
      + " Local imports remain saved.";
  } else if (cancelled) {
    nextStep = `Re-run import_music_batch with batchId "${plan.batchId}" and resume:true to continue from item ${plan.items.length - remaining + 1}.`;
  } else if (failed) {
    nextStep = syncPreflightError
      ? `Sync target ${syncTarget} could not be listed (${syncPreflightError.code}); no additions were attempted. Verify the playlist, then re-run import_music_batch with batchId "${plan.batchId}" and syncPlaylist to retry.`
      : syncFailed
        ? "Inspect sync.results and verify playlist membership by exact video ID before retrying failed additions; local imports remain saved."
        : `Inspect each failed or retryable item in results; re-run import_music_batch with batchId "${plan.batchId}" and resume:true after the provider recovers.`;
  }
  if (resultsTruncated || syncTruncated) {
    const hint = `Receipt truncated at ${MAX_DETAIL_ITEMS} entries; page import_status with batchId "${plan.batchId}" and offset/limit for the full per-item record.`;
    nextStep = nextStep ? `${nextStep} ${hint}` : hint;
  }

  return {
    mode: "apply",
    action,
    batchId: plan.batchId,
    counts: countBy(plan.items),
    results: resultsTruncated ? results.slice(0, MAX_DETAIL_ITEMS) : results,
    ...(resultsTruncated ? { resultsTruncated: true, resultsTotal: results.length } : {}),
    remaining,
    ...(syncTarget ? {
      sync: {
        playlistId: syncTarget,
        results: syncTruncated ? syncResults.slice(0, MAX_DETAIL_ITEMS) : syncResults,
        ...(syncTruncated ? { resultsTruncated: true, resultsTotal: syncResults.length } : {}),
        failed: syncFailed,
        unknown: syncUnknown.length,
        ...(syncPreflightError ? { error: syncPreflightError } : {}),
      },
    } : {}),
    ...(nextStep ? { nextStep } : {}),
  };
}

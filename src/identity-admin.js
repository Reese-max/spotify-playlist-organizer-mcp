// identity-admin: exposes the canonical identity review queue and manual
// merge/split decisions to MCP callers. Every mutation is preview-first and
// keyed by stable local track IDs and exact track_sources row IDs — never
// display names. Identity decisions are library-local: provider playlists
// are never touched, and locked tracks are never silently auto-merged.

import { LibraryError } from "./library.js";

function requireTrack(library, trackId) {
  const track = library.getTrackById(Number(trackId));
  if (!track) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "Unknown trackId: " + trackId);
  }
  return track;
}

function sourceRef(source) {
  return {
    id: source.id,
    provider: source.provider,
    sourceId: source.sourceId,
    sourceType: source.sourceType ?? null,
    versionType: source.versionType ?? null,
  };
}

function trackSummary(library, track) {
  return {
    trackId: track.id,
    title: track.canonicalTitle,
    artist: track.artist ?? null,
    identityLocked: track.identityLocked,
    needsReview: track.needsReview,
    sources: library.listTrackSources(track.id).map(sourceRef),
    tags: library.listTags(track.id),
    playlists: library.listTrackPlaylists(track.id),
  };
}

export function listIdentityReviews(library) {
  const items = library.identityReviewQueue().map((row) => ({
    trackId: row.trackId,
    trackTitle: row.trackTitle,
    candidateTrackId: row.candidateTrackId,
    candidateTitle: row.candidateTitle,
    confidence: row.confidence,
    reason: row.reason,
    decidedAt: row.decidedAt,
    trackNeedsReview: library.getTrackById(row.trackId)?.needsReview ?? null,
    sources: library.listTrackSources(row.trackId).map(sourceRef),
    candidateSources: library.listTrackSources(row.candidateTrackId).map(sourceRef),
  }));
  return {
    count: items.length,
    items,
    nextStep: "Confirm a pair with merge_music_tracks, or dismiss it with resolve_identity_review.",
  };
}

export function mergeMusicTracks(library, args = {}) {
  const into = requireTrack(library, args.intoTrackId);
  const from = requireTrack(library, args.fromTrackId);
  if (into.id === from.id) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "Cannot merge a track into itself.");
  }
  const intoDetail = trackSummary(library, into);
  const fromDetail = trackSummary(library, from);
  if (args.mode !== "apply") {
    return {
      mode: "preview",
      into: intoDetail,
      from: fromDetail,
      changes: {
        sourcesMoved: fromDetail.sources,
        tagsAdded: fromDetail.tags,
        playlistsAdded: fromDetail.playlists,
        aliasAdded: from.canonicalKey,
        trackDeleted: from.id,
      },
      impact:
        "apply moves every source/tag/playlist of `from` into `into`, remembers the removed " +
        "track's canonical key as an alias, and deletes track `from`. Reversible only via " +
        "split_music_track by sourceId — confirm this preview is what you intend.",
      nextStep: "Re-run with mode \"apply\" to merge.",
    };
  }
  const merged = library.mergeTracks(into.id, from.id);
  return {
    mode: "apply",
    mergedTrackIds: { into: into.id, from: from.id },
    track: trackSummary(library, merged),
    note: "Manual merge recorded — later sources matching the removed track's canonical key attach here. Provider playlists were not touched.",
  };
}

export function splitMusicTrack(library, args = {}) {
  const original = requireTrack(library, args.trackId);
  const allSources = library.listTrackSources(original.id);
  const requested = Array.isArray(args.sourceIds) ? [...new Set(args.sourceIds.map(Number))] : [];
  if (!requested.length || requested.some((id) => !Number.isInteger(id) || id < 1)) {
    throw new LibraryError(
      "LIBRARY_INPUT_INVALID",
      "sourceIds must be a non-empty array of track_sources row ids.",
    );
  }
  const owned = new Set(allSources.map((source) => source.id));
  const missing = requested.filter((id) => !owned.has(id));
  if (missing.length) {
    throw new LibraryError(
      "LIBRARY_INPUT_INVALID",
      "sourceIds not on this track: " + missing.join(", "),
    );
  }
  const moving = allSources.filter((source) => requested.includes(source.id));
  const remaining = allSources.filter((source) => !requested.includes(source.id));
  const fields = args.fields && typeof args.fields === "object" ? args.fields : {};
  if (args.mode !== "apply") {
    return {
      mode: "preview",
      trackId: original.id,
      movingSources: moving.map(sourceRef),
      remainingSources: remaining.map(sourceRef),
      newTrack: {
        title: fields.title ?? original.canonicalTitle,
        artist: fields.artist ?? original.artist ?? null,
        identityLocked: true,
        copiesTags: true,
        copiesPlaylists: true,
      },
      ...(remaining.length === 0
        ? { warning: "All sources selected — the original track would keep none." }
        : {}),
      nextStep: "Re-run with mode \"apply\" to split.",
    };
  }
  const result = library.splitTrack(original.id, requested, fields);
  return {
    mode: "apply",
    newTrack: trackSummary(library, result.track),
    originalTrack: trackSummary(library, result.originalTrack),
    movedSourceIds: result.movedSourceIds,
    note: "Split recorded with provenance manual_split; provider playlists were not touched.",
  };
}

export function resolveIdentityReview(library, args = {}) {
  const track = requireTrack(library, args.trackId);
  const candidate = requireTrack(library, args.candidateTrackId);
  const decision = args.decision ?? "distinct";
  if (decision !== "distinct") {
    throw new LibraryError(
      "LIBRARY_INPUT_INVALID",
      "decision must be \"distinct\" — use merge_music_tracks to confirm a pair as the same track.",
    );
  }
  const lock = args.lock === true;
  const pending = library.identityReviewQueue().some(
    (row) =>
      (row.trackId === track.id && row.candidateTrackId === candidate.id)
      || (row.trackId === candidate.id && row.candidateTrackId === track.id),
  );
  if (args.mode !== "apply") {
    return {
      mode: "preview",
      trackId: track.id,
      candidateTrackId: candidate.id,
      pairPending: pending,
      decision,
      lock,
      changes: {
        candidatePairDismissed: pending,
        needsReviewClearedWhenNoPairsRemain: true,
        identityLocked: lock,
      },
      nextStep: "Re-run with mode \"apply\" to record the decision.",
    };
  }
  library.dismissIdentityCandidate(track.id, candidate.id);
  let locked = null;
  if (lock) {
    library.setIdentityLocked(track.id, true);
    library.setIdentityLocked(candidate.id, true);
    locked = [track.id, candidate.id];
  }
  return {
    mode: "apply",
    dismissed: { trackId: track.id, candidateTrackId: candidate.id, pairWasPending: pending },
    trackNeedsReview: library.getTrackById(track.id).needsReview,
    candidateNeedsReview: library.getTrackById(candidate.id).needsReview,
    locked,
    note: "Manual decision recorded — the pair is no longer a review candidate, and locked tracks are never silently auto-merged.",
  };
}

export function setIdentityLock(library, args = {}) {
  const track = requireTrack(library, args.trackId);
  const locked = args.locked !== false;
  const before = track.identityLocked;
  const after = library.setIdentityLocked(track.id, locked).identityLocked;
  return {
    trackId: track.id,
    before,
    after,
    note: locked
      ? "Locked: future identical sources become review candidates, never silent auto-merges."
      : "Unlocked: automatic identity matching resumes for this track.",
  };
}

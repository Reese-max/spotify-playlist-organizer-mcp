// playlist-admin: day-to-day YouTube playlist maintenance with a hard effect
// boundary between provider mutations and Personal Library CRUD. Reads are
// read-only; every mutation is preview-first, uses exact IDs only (display
// names are never identifiers), verifies results by exact-ID read-back, and
// reports UNKNOWN_AFTER_WRITE rather than claiming success when a write
// cannot be verified. delete_playlist additionally demands an independent
// confirmation — nothing here can be triggered implicitly by sync/cleanup.

import { LibraryError } from "./library.js";
import { parseYouTubePlaylistReference } from "./youtube.js";

const MAX_PAGE = 100;

function errorInfo(error) {
  return {
    code: error?.code ?? "PROVIDER_ERROR",
    message: error instanceof Error ? error.message : String(error),
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  };
}

function isAmbiguousWriteError(error) {
  return ["TIMEOUT", "CALLER_CANCELLED", "NETWORK_ERROR"].includes(error?.code)
    || error?.status === 429
    || error?.status >= 500;
}

function isNotFound(error) {
  return error?.code === "NOT_FOUND" || error?.status === 404;
}

function requirePlaylistId(reference) {
  const parsed = parseYouTubePlaylistReference(reference);
  if (!parsed.id) {
    throw new LibraryError(
      "LIBRARY_INPUT_INVALID",
      "playlist must be an exact playlist ID or URL, not a name.",
    );
  }
  return parsed.id;
}

function boundedLimit(limit) {
  const value = Number(limit ?? 50);
  if (!Number.isInteger(value) || value < 1) return 50;
  return Math.min(value, MAX_PAGE);
}

function boundedOffset(offset) {
  const value = Number(offset ?? 0);
  if (!Number.isInteger(value) || value < 0) return 0;
  return value;
}

export async function getPlaylistAdmin({ youtube }, args = {}, { signal } = {}) {
  const playlistId = requirePlaylistId(args.playlist);
  const playlist = await youtube.getPlaylist(playlistId, { signal });
  const items = await youtube.getPlaylistItems(playlistId, { signal });
  return { playlist: { ...playlist, id: playlistId, itemCount: items.length } };
}

export async function listPlaylistItemsAdmin({ youtube }, args = {}, { signal } = {}) {
  const playlistId = requirePlaylistId(args.playlist);
  const limit = boundedLimit(args.limit);
  const offset = boundedOffset(args.offset);
  const all = await youtube.getPlaylistItems(playlistId, { signal });
  return {
    playlistId,
    items: all.slice(offset, offset + limit),
    total: all.length,
    limit,
    offset,
    hasMore: offset + limit < all.length,
  };
}

export async function renamePlaylistAdmin({ youtube }, args = {}, { signal } = {}) {
  const playlistId = requirePlaylistId(args.playlist);
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "A non-empty name is required.");
  }
  const current = await youtube.getPlaylist(playlistId, { signal });
  if (args.mode !== "apply") {
    return {
      mode: "preview",
      playlistId,
      oldName: current.name ?? null,
      newName: name,
      nextStep: "Re-run with mode \"apply\" to rename.",
    };
  }

  try {
    await youtube.renamePlaylist(playlistId, name, { signal });
  } catch (error) {
    if (!isAmbiguousWriteError(error)) {
      return {
        mode: "apply",
        playlistId,
        writeState: "FAILED_NO_CONFIRMED_EFFECT",
        error: errorInfo(error),
      };
    }
    // Lost response — verify by exact-ID read-back before claiming anything.
    const verified = await readBackName(youtube, playlistId, signal);
    return {
      mode: "apply",
      playlistId,
      writeState: verified === name ? "RENAMED" : "UNKNOWN_AFTER_WRITE",
      verified: verified === null ? null : { name: verified },
      error: errorInfo(error),
      nextStep: verified === name
        ? "Read-back confirms the rename landed; no retry needed."
        : "The write result is uncertain — reconcile via youtube_get_playlist read-back before retrying.",
    };
  }

  const verified = await readBackName(youtube, playlistId, signal);
  return {
    mode: "apply",
    playlistId,
    writeState: verified === name ? "RENAMED" : "UNKNOWN_AFTER_WRITE",
    verified: verified === null ? null : { name: verified },
    ...(verified === name
      ? {}
      : { nextStep: "Rename could not be verified — re-check with youtube_get_playlist." }),
  };
}

async function readBackName(youtube, playlistId, signal) {
  try {
    const playlist = await youtube.getPlaylist(playlistId, { signal });
    return playlist.name ?? null;
  } catch {
    return null;
  }
}

async function readBackMembership(youtube, playlistId, { videoId, playlistItemId }, signal) {
  try {
    const items = await youtube.getPlaylistItems(playlistId, { signal });
    if (playlistItemId) {
      return items.some((item) => item.playlistItemId === playlistItemId);
    }
    return items.some((item) => item.id === videoId);
  } catch {
    return null; // unreadable
  }
}

export async function removeFromPlaylist({ youtube }, args = {}, { signal } = {}) {
  const playlistId = requirePlaylistId(args.playlist);
  const videoId = typeof args.videoId === "string" ? args.videoId.trim() : "";
  if (!videoId) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "An exact videoId is required.");
  }
  const items = await youtube.getPlaylistItems(playlistId, { signal });
  const match = items.find((item) => item.id === videoId);

  if (args.mode !== "apply") {
    return {
      mode: "preview",
      playlistId,
      item: match
        ? { videoId, playlistItemId: match.playlistItemId ?? null, name: match.name ?? null }
        : null,
      present: Boolean(match),
      note: "Removing a playlist item is a provider-only effect; the Personal Library canonical track is not touched.",
      nextStep: "Re-run with mode \"apply\" to remove this item.",
    };
  }

  let removedItemId = null;
  try {
    const outcome = await youtube.removeVideoFromPlaylist(playlistId, videoId, { signal });
    if (outcome?.removed === false || outcome?.reason === "not_in_playlist") {
      return { mode: "apply", playlistId, videoId, writeState: "NOT_PRESENT" };
    }
    removedItemId = outcome?.playlistItemId ?? null;
  } catch (error) {
    if (!isAmbiguousWriteError(error)) {
      return {
        mode: "apply",
        playlistId,
        videoId,
        writeState: "FAILED_NO_CONFIRMED_EFFECT",
        error: errorInfo(error),
      };
    }
    const present = await readBackMembership(youtube, playlistId, { videoId }, signal);
    return {
      mode: "apply",
      playlistId,
      videoId,
      writeState: present === false ? "REMOVED" : "UNKNOWN_AFTER_WRITE",
      error: errorInfo(error),
      nextStep: present === false
        ? "Read-back confirms the item is gone; no retry needed."
        : "The write result is uncertain — verify membership via youtube_list_playlist_items before retrying.",
    };
  }

  // Verify the removed playlist-item row specifically — a duplicate video
  // entry elsewhere in the playlist is not a failure.
  const present = await readBackMembership(
    youtube,
    playlistId,
    { videoId, playlistItemId: removedItemId },
    signal,
  );
  return {
    mode: "apply",
    playlistId,
    videoId,
    writeState: present === true ? "UNKNOWN_AFTER_WRITE" : "REMOVED",
    verified: present,
    ...(present === true
      ? { nextStep: "The item still appears in the playlist — verify before retrying." }
      : {}),
  };
}

export async function deletePlaylist({ youtube }, args = {}, { signal } = {}) {
  const playlistId = requirePlaylistId(args.playlist);
  const current = await youtube.getPlaylist(playlistId, { signal });
  const items = await youtube.getPlaylistItems(playlistId, { signal });

  if (args.mode !== "apply") {
    return {
      mode: "preview",
      playlist: { id: playlistId, name: current.name ?? null, itemCount: items.length },
      nextStep: `Re-run with mode "apply" and confirmPlaylistId "${playlistId}" to permanently delete this playlist. This cannot be undone and is never triggered by sync or cleanup.`,
    };
  }

  // Independent authorization: the caller must re-state the exact playlist ID.
  if (args.confirmPlaylistId !== playlistId) {
    return {
      mode: "apply",
      playlistId,
      writeState: "FAILED_NO_CONFIRMED_EFFECT",
      nextStep: `Pass confirmPlaylistId "${playlistId}" to confirm deletion.`,
    };
  }

  try {
    await youtube.deletePlaylist(playlistId, { signal });
  } catch (error) {
    if (!isAmbiguousWriteError(error)) {
      return {
        mode: "apply",
        playlistId,
        writeState: "FAILED_NO_CONFIRMED_EFFECT",
        error: errorInfo(error),
      };
    }
    const gone = await readBackGone(youtube, playlistId, signal);
    return {
      mode: "apply",
      playlistId,
      writeState: gone === true ? "DELETED" : "UNKNOWN_AFTER_WRITE",
      verified: gone === true ? null : { exists: gone },
      error: errorInfo(error),
      nextStep: gone === true
        ? "Read-back confirms the playlist is gone."
        : "Deletion result is uncertain — verify with youtube_get_playlist before retrying.",
    };
  }

  const gone = await readBackGone(youtube, playlistId, signal);
  return {
    mode: "apply",
    playlistId,
    writeState: gone === true ? "DELETED" : "UNKNOWN_AFTER_WRITE",
    verified: gone === true ? null : { exists: gone },
    ...(gone === true
      ? {}
      : { nextStep: "Deletion could not be verified — check youtube_get_playlist." }),
  };
}

async function readBackGone(youtube, playlistId, signal) {
  try {
    await youtube.getPlaylist(playlistId, { signal });
    return false;
  } catch (error) {
    return isNotFound(error) ? true : null;
  }
}

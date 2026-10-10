import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createHttpServer } from "../src/http-server.js";
import { openLibrary } from "../src/library.js";

const PL_A = "PL_HTTP_UI_AAAA";
const VID_A = "V_HTTPUI_01";
const VID_B = "V_HTTPUI_02";

class StubYouTube {
  constructor() {
    this.playlists = new Map();
    this.items = new Map();
    this.videos = new Map();
    this.failNextAdd = false;
    this.rejectNextAdd = false;
  }
  async getPlaylist(id) {
    const playlist = this.playlists.get(id);
    if (!playlist) {
      const error = new Error("not found");
      error.status = 404;
      throw error;
    }
    return playlist;
  }
  async listPlaylists() {
    return { playlists: [...this.playlists.values()] };
  }
  async getPlaylistItems(id) {
    return [...(this.items.get(id) ?? [])];
  }
  async getVideo(id) {
    const video = this.videos.get(id);
    if (!video) {
      const error = new Error("not found");
      error.status = 404;
      throw error;
    }
    return video;
  }
  async searchVideos() {
    return { videos: [...this.videos.values()] };
  }
  async createPlaylist(name) {
    const id = `PL_STUB_${this.playlists.size}`;
    this.playlists.set(id, { id, name });
    this.items.set(id, []);
    return { id, name };
  }
  async addVideoToPlaylist(playlistId, videoId) {
    // A definite rejection (4xx) never lands the write — the provider
    // confirmed nothing changed, unlike the ambiguous failNextAdd path.
    if (this.rejectNextAdd) {
      this.rejectNextAdd = false;
      const error = new Error("playlistItems.insert rejected");
      error.status = 400;
      throw error;
    }
    const list = this.items.get(playlistId) ?? [];
    // The write lands before the armed failure — read-back later sees it.
    const video = this.videos.get(videoId);
    if (!list.some((item) => item.id === videoId)) {
      list.push({ id: videoId, name: video?.name ?? videoId, channel: video?.channel });
    }
    this.items.set(playlistId, list);
    if (this.failNextAdd) {
      this.failNextAdd = false;
      const error = new Error("backend exploded after applying the write");
      error.status = 500;
      throw error;
    }
    return { added: true };
  }
  async removeVideoFromPlaylist() {
    return { removed: true };
  }
}

async function startServer(t, { youtube = new StubYouTube(), ...options } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "music-http-ui-"));
  const library = openLibrary(path.join(directory, "library.sqlite"));
  const server = createHttpServer({
    library,
    youtube,
    bootstrapToken: "test-bootstrap-token",
    ...options,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    library.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { base, library, youtube };
}

async function api(base, method, route, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return fetch(`${base}${route}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function session(base) {
  const response = await api(base, "POST", "/session", {
    body: { token: "test-bootstrap-token" },
  });
  assert.equal(response.status, 200);
  return (await response.json()).token;
}

test("GET / serves the mobile collection shell without a session and without secrets", async (t) => {
  const { base } = await startServer(t);
  const response = await api(base, "GET", "/");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
  const html = await response.text();

  // Mobile-first shell.
  assert.match(html, /name="viewport" content="width=device-width/);
  assert.match(html, /max-width:\s*480px/);
  // The states the UI must render — selection, confirm, duplicate,
  // unknown-after-write — are all present in the shell.
  for (const marker of [
    "selection_required", "reconciliation_required", "skipped_duplicate",
    "partial_failure", "needs review", "Run reconcile", "/api/save_music",
    "/api/library/recent", "/api/library/unsynced",
    "EXACT_SOURCE_DUPLICATE", "SAME_CANONICAL_TRACK", "DISTINCT_TRACK",
    "skipped_canonical_duplicate", "Same song already in playlist",
    "different upload", "Save anyway", "already in playlist",
    "Run read-back reconcile",
  ]) {
    assert.ok(html.includes(marker), "shell missing UI state " + marker);
  }
  // The shell carries no bootstrap secret and no provider credential names.
  assert.equal(html.includes("test-bootstrap-token"), false);
  for (const forbidden of ["YOUTUBE_ACCESS_TOKEN", "YOUTUBE_REFRESH_TOKEN", "CLIENT_SECRET", "PASSPHRASE", "credentialPath"]) {
    assert.equal(html.includes(forbidden), false, "shell leaks " + forbidden);
  }
});

test("collection flow: paste → candidate select → preview → confirm → saved → recent/unsynced", async (t) => {
  const { base, youtube } = await startServer(t);
  youtube.playlists.set(PL_A, { id: PL_A, name: "UI Playlist" });
  youtube.items.set(PL_A, []);
  youtube.videos.set(VID_A, { id: VID_A, name: "UI Song One" });
  youtube.videos.set(VID_B, { id: VID_B, name: "UI Song Two" });
  const token = await session(base);

  // 1. Free text preview returns candidates — the UI must not auto-pick.
  const ambiguous = await api(base, "POST", "/api/save_music", {
    token,
    body: { input: "UI Song", mode: "preview", playlist: PL_A },
  });
  assert.equal(ambiguous.status, 200);
  const ambiguousBody = await ambiguous.json();
  assert.equal(ambiguousBody.action, "selection_required");
  assert.ok(ambiguousBody.candidates.length >= 2);

  // 2. Selecting a candidate by exact videoId produces the preview the
  //    confirm screen renders: classification, duplicate state, playlist.
  const preview = await api(base, "POST", "/api/save_music", {
    token,
    body: { input: "UI Song", videoId: VID_B, mode: "preview", playlist: PL_A },
  });
  const previewBody = await preview.json();
  assert.equal(previewBody.mode, "preview");
  assert.equal(previewBody.library.writeState, "PREVIEW");
  assert.ok(previewBody.classification);
  assert.ok(previewBody.duplicate);
  assert.equal(previewBody.youtube.playlist.id, PL_A);

  // 3. Confirm → apply.
  const apply = await api(base, "POST", "/api/save_music", {
    token,
    body: { input: "UI Song", videoId: VID_B, mode: "apply", playlist: PL_A },
  });
  const applied = await apply.json();
  assert.equal(applied.action, "saved");
  const trackId = applied.ids.trackId;

  // 4. The home screen reads: recent shows the saved track.
  const recent = await api(base, "GET", "/api/library/recent?limit=15", { token });
  const recentBody = await recent.json();
  assert.ok(recentBody.items.some((item) => item.id === trackId));

  // 5. A track saved without YouTube sync lands in needs-attention.
  const localOnly = await api(base, "POST", "/api/save_music", {
    token,
    body: { input: "UI Song", videoId: VID_A, mode: "apply", syncToYouTube: false },
  });
  assert.equal((await localOnly.json()).action, "saved");
  const unsynced = await api(base, "GET", "/api/library/unsynced", { token });
  const unsyncedBody = await unsynced.json();
  const localTrack = unsyncedBody.items.find((item) => item.track.canonicalTitle === "UI Song One");
  assert.ok(localTrack, "unsynced list should contain the local-only track");
  assert.ok(localTrack.reasons.includes("not_synced"));
});

test("re-saving the same video surfaces the duplicate receipt without duplicating", async (t) => {
  const { base, library, youtube } = await startServer(t);
  youtube.playlists.set(PL_A, { id: PL_A, name: "UI Playlist" });
  youtube.items.set(PL_A, []);
  youtube.videos.set(VID_A, { id: VID_A, name: "UI Song One", channel: "UI Channel" });
  const token = await session(base);
  const payload = { input: "UI Song", videoId: VID_A, mode: "apply", playlist: PL_A };

  const first = await api(base, "POST", "/api/save_music", { token, body: payload });
  assert.equal((await first.json()).action, "saved");

  // The confirm screen re-previews before apply — the receipt must carry the
  // exact-duplicate signals that its badge and "Save anyway" button read.
  const preview = await api(base, "POST", "/api/save_music", {
    token,
    body: { ...payload, mode: "preview" },
  });
  const previewBody = await preview.json();
  assert.equal(previewBody.action, "would_skip_duplicate");
  assert.equal(previewBody.duplicate.level, "EXACT_SOURCE_DUPLICATE");
  assert.equal(previewBody.duplicate.youtubePlaylistItem, true);

  const second = await api(base, "POST", "/api/save_music", { token, body: payload });
  const receipt = await second.json();
  assert.equal(receipt.action, "skipped_duplicate");
  assert.equal(receipt.duplicate.level, "EXACT_SOURCE_DUPLICATE");
  assert.equal(receipt.duplicate.youtubePlaylistItem, true);
  assert.equal(receipt.duplicate.youtubePlaylistItemKind, "exact_source");
  assert.equal(receipt.library.action, "existing");
  assert.equal(receipt.youtube.action, "skipped_duplicate");

  // Nothing was collected twice: one track, one playlist row.
  assert.equal(library.trackCount(), 1);
  assert.equal(youtube.items.get(PL_A).length, 1);
});

test("a different upload of the same song skips the playlist write canonically", async (t) => {
  const { base, library, youtube } = await startServer(t);
  youtube.playlists.set(PL_A, { id: PL_A, name: "UI Playlist" });
  youtube.items.set(PL_A, []);
  youtube.videos.set(VID_A, { id: VID_A, name: "UI Song One", channel: "UI Channel" });
  youtube.videos.set(VID_B, { id: VID_B, name: "UI Song One - Official Audio", channel: "UI Channel" });
  const token = await session(base);

  const first = await api(base, "POST", "/api/save_music", {
    token,
    body: { input: "UI Song One", videoId: VID_A, mode: "apply", playlist: PL_A },
  });
  assert.equal((await first.json()).action, "saved");

  // Preview of a different upload: the library would attach a second source
  // but the playlist already holds a sibling — the confirm screen needs both
  // signals to explain why no playlist write will happen.
  const preview = await api(base, "POST", "/api/save_music", {
    token,
    body: { input: "UI Song One", videoId: VID_B, mode: "preview", playlist: PL_A },
  });
  const previewBody = await preview.json();
  assert.equal(previewBody.action, "would_save");
  assert.equal(previewBody.duplicate.level, "SAME_CANONICAL_TRACK");
  assert.equal(previewBody.duplicate.youtubePlaylistItem, true);
  assert.equal(previewBody.duplicate.youtubePlaylistItemKind, "canonical_track");
  assert.equal(previewBody.youtube.action, "would_skip_canonical_duplicate");

  const apply = await api(base, "POST", "/api/save_music", {
    token,
    body: { input: "UI Song One", videoId: VID_B, mode: "apply", playlist: PL_A },
  });
  const receipt = await apply.json();
  // The top-level action is "saved" — the library did attach the new source —
  // while the YouTube step skipped the add; the UI must show the canonical
  // skip rather than implying the video was added to the playlist.
  assert.equal(receipt.action, "saved");
  assert.equal(receipt.youtube.action, "skipped_canonical_duplicate");
  assert.equal(receipt.youtube.writeState, "ALREADY_PRESENT");
  assert.equal(receipt.duplicate.youtubePlaylistItemKind, "canonical_track");
  assert.match(receipt.nextStep, /same canonical track/);

  // One canonical track, two sources, one playlist item — no duplication.
  assert.equal(library.trackCount(), 1);
  assert.equal(youtube.items.get(PL_A).length, 1);
  const track = library.listTrackSources(receipt.ids.trackId)
    .filter((source) => source.provider === "youtube")
    .map((source) => source.sourceId);
  assert.deepEqual(track.sort(), [VID_A, VID_B].sort());
});

test("a playlist created then rejected reports PARTIAL_PLAYLIST_CREATED with a safe next step", async (t) => {
  const { base, youtube } = await startServer(t);
  youtube.videos.set(VID_A, { id: VID_A, name: "Partial UI Song" });
  youtube.rejectNextAdd = true;
  const token = await session(base);

  // A playlist name (not an ID) resolves via listPlaylists → createPlaylist.
  const apply = await api(base, "POST", "/api/save_music", {
    token,
    body: { input: "Partial UI Song", videoId: VID_A, mode: "apply", playlist: "Brand New List" },
  });
  assert.equal(apply.status, 200);
  const receipt = await apply.json();
  assert.equal(receipt.action, "reconciliation_required");
  assert.equal(receipt.youtube.writeState, "PARTIAL_PLAYLIST_CREATED");
  assert.equal(receipt.youtube.playlistAction, "created");
  assert.equal(receipt.library.writeState, "SAVED");
  assert.ok(receipt.ids.trackId);
  assert.ok(receipt.ids.playlistId);
  // The UI's .next box renders this — it must name the read-back path and
  // the returned playlist ID, not a generic error.
  assert.match(receipt.nextStep, /playlist ID/);
  assert.match(receipt.nextStep, /only retry if the exact video ID is absent/);

  // The definite rejection landed no remote write — the new playlist is empty.
  assert.equal(youtube.items.get(receipt.ids.playlistId).length, 0);

  // The locally-saved half is still visible on the home screen's recent list.
  const recent = await api(base, "GET", "/api/library/recent?limit=15", { token });
  const recentBody = await recent.json();
  assert.ok(recentBody.items.some((item) => item.id === receipt.ids.trackId));
});

test("unknown-after-write receipt exposes reconcile path over HTTP", async (t) => {
  const { base, youtube } = await startServer(t);
  youtube.playlists.set(PL_A, { id: PL_A, name: "UI Playlist" });
  youtube.items.set(PL_A, []);
  youtube.videos.set(VID_A, { id: VID_A, name: "Ambiguous UI Song" });
  youtube.failNextAdd = true;
  const token = await session(base);

  const apply = await api(base, "POST", "/api/save_music", {
    token,
    body: { input: "Ambiguous UI Song", videoId: VID_A, mode: "apply", playlist: PL_A },
  });
  const applied = await apply.json();
  assert.equal(applied.action, "reconciliation_required");
  assert.equal(applied.youtube.writeState, "UNKNOWN_AFTER_WRITE");
  assert.ok(applied.nextStep);

  const reconciled = await api(base, "POST", "/api/reconcile", {
    token,
    body: { trackId: applied.ids.trackId },
  });
  const resolved = await reconciled.json();
  assert.equal(resolved.sync.state, "synced");
});

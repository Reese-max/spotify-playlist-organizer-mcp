// Executable form of the fixed A01–J05 50-persona quality gate (issue #7).
//
// The audit protocol fixes 50 synthetic personas (10 rows × 5) with stable
// goals and success conditions. This module encodes the subset of each
// persona's expectations that is verifiable in-process — no real provider,
// OAuth, or client is contacted — as named checks over the real product APIs
// (saveMusic, MusicLibrary, CredentialStore, fetchWithDeadline, the spawned
// stdio server). Each persona resolves to one status:
//
//   PASS            every assigned check holds and no runtime evidence is owed
//   NEEDS_RUNTIME   checks hold; remaining acceptance needs real provider /
//                   client / OS / CI execution evidence
//   TRACKED         a check fails and the failure is bound to a declared open
//                   issue (a known current-default defect, not a regression)
//   FAIL            a check fails with no tracker — a new reproducible defect
//
// The verdict is CLEAN only when all 50 personas are PASS. The gate exits
// non-zero on any FAIL; --strict also fails on NOT_CLEAN verdicts.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { canonicalizeSource } from "../src/canonical.js";
import { CredentialStore } from "../src/credentials.js";
import { fetchWithDeadline, ProviderRequestError } from "../src/http.js";
import { openLibrary } from "../src/library.js";
import { reconcileTrack } from "../src/library-sync.js";
import { saveMusic } from "../src/save-music.js";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const VIDEO_ID = "dQw4w9WgXcQ";
const WATCH_URL = "https://www.youtube.com/watch?v=" + VIDEO_ID;
const SENTINEL = "GATE-SENTINEL-9f3d";

export const PERSONA_STATUSES = Object.freeze([
  "PASS",
  "NEEDS_RUNTIME",
  "TRACKED",
  "FAIL",
]);

function fail(message) {
  throw new Error(message);
}

function assertCheck(condition, message) {
  if (!condition) fail(message);
}

// Race a promise against an external deadline whose timer is always cleared.
function boundedRace(promise, ms) {
  let timer;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("probe did not settle within " + ms + " ms")),
      ms,
    );
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

function videoFixture(id = VIDEO_ID) {
  return {
    id,
    name: "Daft Punk - One More Time (Official Video)",
    artists: ["Daft Punk"],
    channel: "Daft Punk",
    url: "https://www.youtube.com/watch?v=" + id,
    platform: "youtube",
    description: "Discovery era dance track",
  };
}

// Minimal YouTube provider stub — the same shape test/save-music.test.js uses.
function stubYouTube() {
  const calls = [];
  const playlists = [];
  const items = new Map();
  return {
    env: {},
    calls,
    playlists,
    items,
    async getVideo(id) {
      calls.push(["getVideo", id]);
      return videoFixture(id);
    },
    async searchVideos(query) {
      calls.push(["searchVideos", query]);
      return {
        query,
        total: 2,
        videos: [videoFixture("AAAAAAAAAAA"), videoFixture("BBBBBBBBBBB")],
      };
    },
    async listPlaylists() {
      calls.push(["listPlaylists"]);
      return { total: playlists.length, playlists };
    },
    async getPlaylist(id) {
      calls.push(["getPlaylist", id]);
      const found = playlists.find((playlist) => playlist.id === id);
      if (!found) throw new Error("YouTube playlist was not found: " + id);
      return found;
    },
    async getPlaylistItems(id) {
      calls.push(["getPlaylistItems", id]);
      return items.get(id) ?? [];
    },
    async createPlaylist(name) {
      calls.push(["createPlaylist", name]);
      const created = {
        id: "PL_CREATED_" + (playlists.length + 1),
        name,
        url: "https://www.youtube.com/playlist?list=PL_CREATED_" + (playlists.length + 1),
      };
      playlists.push(created);
      items.set(created.id, []);
      return created;
    },
    async addVideoToPlaylist(playlistId, videoId) {
      calls.push(["addVideoToPlaylist", playlistId, videoId]);
      const entry = videoFixture(videoId);
      items.set(playlistId, [...(items.get(playlistId) ?? []), entry]);
      return entry;
    },
  };
}

// One isolated fixture per check: a real on-disk library (temp dir, cleaned up
// in finally) plus the stub provider.
async function withFixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "persona-gate-"));
  const library = openLibrary(path.join(directory, "library.sqlite"));
  try {
    return await run({ directory, library, stubYouTube });
  } finally {
    try { library.close(); } catch { /* already closed */ }
    await rm(directory, { recursive: true, force: true });
  }
}

function writeCalls(youtube) {
  return youtube.calls.filter(
    ([name]) => name === "createPlaylist" || name === "addVideoToPlaylist",
  ).length;
}

// A youtube stub whose playlist insert always fails with an ambiguous
// (timeout-class) provider error after a successful playlist create.
function ambiguousWriteStub() {
  const youtube = stubYouTube();
  let addCalls = 0;
  youtube.addVideoToPlaylist = async (playlistId, videoId) => {
    addCalls += 1;
    youtube.calls.push(["addVideoToPlaylist", playlistId, videoId]);
    throw new ProviderRequestError("TIMEOUT", "YouTube add timed out.", { retryable: true });
  };
  return { youtube, addCalls: () => addCalls };
}

export const CHECKS = Object.freeze({
  // save_music must not write anything unless mode "apply" is explicit (E03).
  preview_is_default: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const youtube = stubYouTube();
      const receipt = await saveMusic({ youtube, library }, { input: WATCH_URL });
      assertCheck(receipt.mode === "preview", "default mode must be preview");
      assertCheck(receipt.action === "would_save", "preview should report would_save");
      assertCheck(library.trackCount() === 0, "preview wrote to the library");
      assertCheck(writeCalls(youtube) === 0, "preview issued provider writes");
      return "default call previews; nothing written";
    }),
  },

  // Free-text input must not silently save the top-1 search result (#2).
  free_text_requires_selection: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const youtube = stubYouTube();
      const receipt = await saveMusic(
        { youtube, library },
        { input: "one more time daft punk", mode: "apply" },
      );
      assertCheck(receipt.action === "selection_required", "free-text apply must require selection");
      assertCheck(receipt.candidates.length >= 2, "selection_required must carry candidates");
      assertCheck(receipt.ids.videoId === null, "selection_required bound a video anyway");
      assertCheck(library.trackCount() === 0, "unselected free-text wrote to the library");
      assertCheck(writeCalls(youtube) === 0, "unselected free-text wrote to the provider");
      return "selection_required; nothing written";
    }),
  },

  // The reviewed pick binds its exact videoId; identity cannot drift (B04/F03).
  selected_video_binds: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const youtube = stubYouTube();
      const first = await saveMusic({ youtube, library }, { input: "one more time" });
      const picked = first.candidates[1].id;
      const applied = await saveMusic(
        { youtube, library },
        { input: "one more time", videoId: picked, mode: "apply" },
      );
      assertCheck(applied.action === "saved", "selected apply should save");
      assertCheck(applied.ids.videoId === picked, "apply bound a different videoId");
      assertCheck(
        applied.source.kind === "youtube-video-selection",
        "selection source kind not recorded",
      );
      return "selected videoId bound through apply";
    }),
  },

  // A bare 11-char ID or URL is exact — no search round-trip (B01/J05).
  exact_id_fast_path: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const youtube = stubYouTube();
      const receipt = await saveMusic(
        { youtube, library },
        { input: VIDEO_ID, mode: "apply", syncToYouTube: false },
      );
      assertCheck(receipt.action === "saved", "exact ID apply should save");
      assertCheck(receipt.ids.videoId === VIDEO_ID, "exact ID bound wrongly");
      assertCheck(
        !youtube.calls.some(([name]) => name === "searchVideos"),
        "exact ID path ran a search",
      );
      return "exact ID binds without search";
    }),
  },

  // Re-saving the same video is detected, not double-written (I01).
  exact_duplicate_no_rewrite: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const youtube = stubYouTube();
      await saveMusic({ youtube, library }, { input: WATCH_URL, mode: "apply" });
      const second = await saveMusic({ youtube, library }, { input: WATCH_URL, mode: "apply" });
      assertCheck(second.action === "skipped_duplicate", "second save must be a skipped_duplicate");
      assertCheck(second.youtube.writeState === "ALREADY_PRESENT", "duplicate writeState wrong");
      assertCheck(
        youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length === 1,
        "duplicate triggered a second playlist insert",
      );
      assertCheck(library.trackCount() === 1, "duplicate created a second track");
      return "exact duplicate detected before write";
    }),
  },

  // A stalled provider request resolves to a typed TIMEOUT, not a hang (#6).
  provider_deadline: {
    issues: [],
    run: async () => {
      const started = Date.now();
      try {
        // Outer bound keeps a broken deadline mechanism a FAIL, not a hang.
        await boundedRace(
          fetchWithDeadline(() => new Promise(() => {}), "https://provider.invalid/", {}, {
            timeoutMs: 25,
            operation: "gate probe",
          }),
          5_000,
        );
      } catch (error) {
        assertCheck(error instanceof ProviderRequestError, "timeout must be a ProviderRequestError");
        assertCheck(error.code === "TIMEOUT", "deadline error code must be TIMEOUT");
        assertCheck(Date.now() - started < 5_000, "deadline did not bound the request");
        return "stalled request bounded by TIMEOUT";
      }
      fail("stalled request was not bounded");
    },
  },

  // Caller cancellation propagates into the provider request (#6).
  caller_cancellation: {
    issues: [],
    run: async () => {
      const controller = new AbortController();
      const pending = fetchWithDeadline(() => new Promise(() => {}), "https://provider.invalid/", {}, {
        signal: controller.signal,
        timeoutMs: 60_000,
        operation: "gate probe",
      });
      controller.abort();
      try {
        // If abort propagation regressed, the outer bound fails the check
        // instead of hanging the suite for a minute.
        await boundedRace(pending, 5_000);
      } catch (error) {
        assertCheck(error.code === "CALLER_CANCELLED", "abort must surface CALLER_CANCELLED");
        return "caller abort propagated";
      }
      fail("caller abort did not cancel the request");
    },
  },

  // create-ok + insert-unknown must surface a typed partial state with the
  // created playlist ID and a safe next step — not a generic error (#4).
  ambiguous_write_typed: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const { youtube } = ambiguousWriteStub();
      const receipt = await saveMusic(
        { youtube, library },
        { input: WATCH_URL, mode: "apply" },
      );
      assertCheck(
        receipt.youtube.writeState === "UNKNOWN_AFTER_WRITE",
        "ambiguous write must be UNKNOWN_AFTER_WRITE",
      );
      assertCheck(receipt.action === "reconciliation_required", "action must ask for reconciliation");
      assertCheck(receipt.ids.playlistId === "PL_CREATED_1", "created playlist ID not surfaced");
      assertCheck(typeof receipt.nextStep === "string" && receipt.nextStep.length > 0,
        "partial receipt lacks a nextStep");
      assertCheck(receipt.completedSteps.includes("youtube_playlist_created"),
        "completed step missing");
      assertCheck(!receipt.completedSteps.includes("youtube_video_added"),
        "unconfirmed step claimed complete");
      return "partial state typed with playlist ID + nextStep";
    }),
  },

  // Ambiguous writes are never blindly retried or re-created (D04/I04).
  no_blind_write_retry: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const { youtube, addCalls } = ambiguousWriteStub();
      const receipt = await saveMusic(
        { youtube, library },
        { input: WATCH_URL, mode: "apply" },
      );
      assertCheck(receipt.youtube.writeState === "UNKNOWN_AFTER_WRITE", "fixture not ambiguous");
      assertCheck(addCalls() === 1, "write was retried blindly");
      assertCheck(
        youtube.calls.filter(([name]) => name === "createPlaylist").length === 1,
        "playlist was re-created",
      );
      return "one write attempt; no blind retry";
    }),
  },

  // After an ambiguous write, reconcile_track resolves the outcome by exact-ID
  // read-back instead of guessing (I02/I05).
  exact_id_readback_reconcile: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const { youtube } = ambiguousWriteStub();
      const receipt = await saveMusic(
        { youtube, library },
        { input: WATCH_URL, mode: "apply" },
      );
      assertCheck(receipt.youtube.writeState === "UNKNOWN_AFTER_WRITE", "fixture not ambiguous");
      // The provider actually applied the write; the follow-up read sees it.
      youtube.items.set("PL_CREATED_1", [videoFixture(VIDEO_ID)]);
      const resolved = await reconcileTrack(
        { library, youtube },
        { trackId: receipt.ids.trackId },
      );
      assertCheck(
        resolved.presence.some((entry) => entry.present === true && entry.videoId === VIDEO_ID),
        "read-back did not find the exact videoId",
      );
      assertCheck(resolved.sync.state === "synced", "reconcile did not reach a known state");
      return "exact-ID read-back resolves the write";
    }),
  },

  // A playlist URL offered as a track must fail clearly without writes (I03).
  invalid_input_rejected: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const youtube = stubYouTube();
      let message = "";
      try {
        await saveMusic(
          { youtube, library },
          { input: "https://www.youtube.com/playlist?list=PLxyz", mode: "apply" },
        );
      } catch (error) {
        message = error.message;
      }
      assertCheck(/playlist/i.test(message), "playlist input error must name the problem");
      assertCheck(library.trackCount() === 0, "invalid input wrote to the library");
      assertCheck(writeCalls(youtube) === 0, "invalid input wrote to the provider");
      return "playlist-as-track rejected with a clear error";
    }),
  },

  // Library reads are bounded — an oversized limit clamps to the page cap (J01).
  pagination_bounded: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      for (let index = 0; index < 3; index += 1) {
        library.upsertTrack({
          title: "Track " + index,
          artist: "Gate",
          source: { provider: "youtube", sourceId: "GATE" + String(index).padStart(7, "0") },
        });
      }
      const page = library.listTracks({ limit: 100_000, offset: -5 });
      assertCheck(page.limit === 100, "list limit was not clamped to the page cap");
      assertCheck(page.offset === 0, "negative offset was not clamped");
      assertCheck(page.items.length === 3 && page.total === 3, "page contents wrong");
      return "limit clamps to 100; offset clamps to 0";
    }),
  },

  // An identity-locked track refuses silent alias attaches (audit trail #5).
  identity_lock_blocks_alias: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const saved = library.upsertTrack({
        title: "One More Time",
        artist: "Daft Punk",
        source: { provider: "youtube", sourceId: VIDEO_ID },
      });
      library.setIdentityLocked(saved.track.id, true);
      let code = "";
      try {
        library.attachCanonicalSource(saved.track.id, {
          provider: "youtube",
          sourceId: "ZZZZZZZZZZZ",
          title: "One More Time",
          channelTitle: "Daft Punk",
        });
      } catch (error) {
        code = error.code;
      }
      assertCheck(code === "LIBRARY_IDENTITY_LOCKED", "locked attach must fail identity_locked");
      return "locked identity blocks silent alias";
    }),
  },

  // Live/cover/remix/remaster are part of canonical identity (A04).
  canonical_version_distinct: {
    issues: [],
    run: async () => {
      const studio = canonicalizeSource({ title: "One More Time", artist: "Daft Punk" });
      const live = canonicalizeSource({ title: "One More Time (Live)", artist: "Daft Punk" });
      const hinted = canonicalizeSource({
        title: "One More Time",
        artist: "Daft Punk",
        versionType: "remix",
      });
      assertCheck(studio.canonicalKey !== live.canonicalKey, "live version merged into studio");
      assertCheck(studio.canonicalKey !== hinted.canonicalKey, "versionType hint not keyed");
      assertCheck(
        studio.canonicalKey.startsWith("ct|") && live.canonicalKey.startsWith("ct|"),
        "canonicalKey shape wrong",
      );
      return "version markers stay inside canonical_key";
    },
  },

  // Secret-shaped keys/values can never enter the library sync_state (#3/C03).
  sync_state_rejects_secrets: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      for (const attempt of [
        () => library.setSyncState("youtube.token", "x"),
        () => library.setSyncState("import.batch7", { accessToken: "x" }),
      ]) {
        let code = "";
        try {
          attempt();
        } catch (error) {
          code = error.code;
        }
        assertCheck(code === "LIBRARY_SECRET_REJECTED", "secret-shaped write was not rejected");
      }
      assertCheck(library.getSyncState("import.batch7") === null, "rejected value was stored");
      return "secret keys rejected before write";
    }),
  },

  // Credentials persist encrypted at rest; status() reports no secrets (#3).
  credentials_encrypted_at_rest: {
    issues: [],
    run: () => withFixture(async ({ directory }) => {
      const filePath = path.join(directory, "credentials.json");
      const store = new CredentialStore({
        YOUTUBE_CREDENTIAL_PASSPHRASE: "gate-passphrase",
        YOUTUBE_CREDENTIAL_FILE: filePath,
      });
      await store.save({
        accessToken: SENTINEL + "-access",
        refreshToken: SENTINEL + "-refresh",
        scope: "https://www.googleapis.com/auth/youtube",
        expiresAt: Date.now() + 3_600_000,
      });
      const raw = await readFile(filePath, "utf8");
      assertCheck(!raw.includes(SENTINEL), "plaintext token persisted to disk");
      assertCheck(JSON.parse(raw).algorithm === "aes-256-gcm", "store is not AES-256-GCM");
      const loaded = await store.load();
      assertCheck(loaded.accessToken === SENTINEL + "-access", "round-trip lost the token");
      const status = await store.status();
      assertCheck(status.status === "READY" && status.refreshable === true, "status() wrong");
      assertCheck(!JSON.stringify(status).includes(SENTINEL), "status() leaks token material");
      return "credentials encrypted at rest; status secret-free";
    }),
  },

  // Receipts never carry environment credential material (C03/J04).
  receipt_carries_no_secret: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const youtube = stubYouTube();
      youtube.env = {
        YOUTUBE_ACCESS_TOKEN: SENTINEL + "-token",
        YOUTUBE_API_KEY: SENTINEL + "-key",
      };
      const preview = await saveMusic({ youtube, library }, { input: WATCH_URL });
      const applied = await saveMusic(
        { youtube, library },
        { input: WATCH_URL, mode: "apply" },
      );
      for (const receipt of [preview, applied]) {
        assertCheck(
          !JSON.stringify(receipt).includes(SENTINEL),
          "receipt carries environment secret material",
        );
      }
      return "no env secret leaks into receipts";
    }),
  },

  // #8: the interactive passphrase prompt must not echo. The defect signature
  // is a readline interface wired to the real stdout for the secret prompt.
  credential_prompt_no_echo: {
    issues: ["#8"],
    run: async ({ root }) => {
      const text = await readFile(path.join(root, "scripts", "youtube-auth.js"), "utf8");
      for (const match of text.matchAll(/createInterface\(\s*\{([^}]*)\}/gs)) {
        const args = match[1];
        const echoes = /\boutput\b(?!\s*:)/.test(args)
          || /\boutput\s*:\s*(?:output|stdout|process\.stdout)\b/.test(args);
        assertCheck(!echoes, "passphrase readline is bound to real stdout — input echoes (#8)");
      }
      return "secret prompt does not echo on TTY";
    },
  },

  // A default-branch CI workflow must exist and run the suite (#5/A03).
  ci_workflow_declared: {
    issues: [],
    run: async ({ root }) => {
      const workflow = await readFile(
        path.join(root, ".github", "workflows", "ci.yml"),
        "utf8",
      );
      assertCheck(/run:\s*npm (run )?(test|test:coverage)/.test(workflow),
        "CI does not run the test suite");
      assertCheck(/run:\s*npm run lint/.test(workflow), "CI does not run lint");
      return "ci.yml runs lint + the test suite";
    },
  },

  // The stdio server must exit 0 on SIGTERM — Linux sends a real signal (H03).
  stdio_signal_exit: {
    issues: [],
    run: async ({ root }) => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "persona-gate-stdio-"));
      const child = spawn(process.execPath, [path.join("src", "server.js")], {
        cwd: root,
        env: { ...process.env, MUSIC_LIBRARY_FILE: path.join(directory, "library.sqlite") },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      // A dead child's stdin write raises EPIPE on the stream, not the promise.
      child.stdin.on("error", () => {});
      const exitPromise = once(child, "exit");
      try {
        const ready = new Promise((resolveReady, rejectReady) => {
          let buffer = "";
          const timer = setTimeout(
            () => rejectReady(new Error("server did not answer initialize")),
            10_000,
          );
          child.stdout.on("data", (chunk) => {
            buffer += chunk.toString();
            if (buffer.split("\n").some((line) => line.trim())) {
              clearTimeout(timer);
              resolveReady();
            }
          });
          child.once("exit", (code) => {
            clearTimeout(timer);
            rejectReady(new Error("server exited " + code + " before initialize: " + stderr));
          });
        });
        child.stdin.write(JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2026-07-28",
            capabilities: {},
            clientInfo: { name: "persona-gate", version: "0" },
          },
        }) + "\n");
        await ready;
        let exitTimer;
        const exitWait = new Promise((resolveWait) => {
          exitTimer = setTimeout(() => resolveWait([null]), 5_000);
        });
        child.kill("SIGTERM");
        const [code] = await Promise.race([exitPromise, exitWait]);
        clearTimeout(exitTimer);
        assertCheck(code === 0, `SIGTERM exit code ${code}; expected 0. ${stderr}`);
        return "SIGTERM exits 0 after initialize";
      } finally {
        child.kill("SIGKILL");
        let reapTimer;
        const reapWait = new Promise((resolveWait) => {
          reapTimer = setTimeout(resolveWait, 1_000);
        });
        await Promise.race([exitPromise, reapWait]);
        clearTimeout(reapTimer);
        // A still-dying child may hold the SQLite file briefly (Windows EPERM);
        // cleanup failure must not mask the check result.
        await rm(directory, { recursive: true, force: true }).catch(() => {});
      }
    },
  },

  // Overlapping-identity saves serialize; no double write, no crash (J02).
  concurrent_save_serialized: {
    issues: [],
    run: () => withFixture(async ({ library }) => {
      const youtube = stubYouTube();
      const [first, second] = await Promise.all([
        saveMusic({ youtube, library }, { input: WATCH_URL, mode: "apply" }),
        saveMusic({ youtube, library }, { input: WATCH_URL, mode: "apply" }),
      ]);
      const actions = [first.action, second.action].sort();
      assertCheck(
        actions[0] === "saved" && actions[1] === "skipped_duplicate",
        "concurrent saves produced " + actions.join("+"),
      );
      assertCheck(
        youtube.calls.filter(([name]) => name === "addVideoToPlaylist").length === 1,
        "concurrent saves double-wrote",
      );
      return "overlapping saves serialize deterministically";
    }),
  },
});

function persona(id, label, checks, runtime) {
  return Object.freeze({
    id,
    label,
    checks: Object.freeze(checks),
    runtime: Object.freeze(runtime),
  });
}

// The fixed A01–J05 grid from the portfolio audit protocol. `checks` are the
// in-repo-verifiable expectations; `runtime` names evidence that can only come
// from a real provider/OAuth/client/OS/CI execution and stays NEEDS_RUNTIME
// until it is produced.
export const PERSONA_MATRIX = Object.freeze([
  persona("A01", "first-save novice, mobile-first",
    ["preview_is_default", "credential_prompt_no_echo"],
    ["real OAuth consent flow", "mobile entry path"]),
  persona("A02", "docs-fluent first-time OAuth setup",
    ["credentials_encrypted_at_rest", "credential_prompt_no_echo"],
    ["real OAuth authorize/revoke (#3)"]),
  persona("A03", "student committing a rules change",
    ["ci_workflow_declared"],
    ["default-branch CI admission receipt (#5)"]),
  persona("A04", "time-pressed free-text save",
    ["free_text_requires_selection", "canonical_version_distinct"],
    ["live search candidate quality (#2)"]),
  persona("A05", "status-dependent partial-failure reader",
    ["ambiguous_write_typed"],
    ["stdio partial-write fixture (#4)"]),
  persona("B01", "non-programmer exact-link save",
    ["exact_id_fast_path", "preview_is_default"],
    ["real provider write receipt"]),
  persona("B02", "junior engineer on a slow network",
    ["provider_deadline", "caller_cancellation"],
    ["stdio tool-level cancel/timeout (#6)"]),
  persona("B03", "reversibility-focused designer",
    ["ambiguous_write_typed"],
    ["stdio handler fixture (#4)"]),
  persona("B04", "provenance-checking researcher",
    ["free_text_requires_selection", "selected_video_binds"],
    ["live candidate ordering (#2)"]),
  persona("B05", "shift worker on mobile scraps of time",
    [],
    ["mobile/small-screen entry path"]),
  persona("C01", "auditor tracing identity and effect",
    ["free_text_requires_selection", "ambiguous_write_typed", "identity_lock_blocks_alias"],
    ["real write audit receipt"]),
  persona("C02", "multi-user low-friction setup",
    ["credential_prompt_no_echo"],
    ["first-run OAuth (#3)"]),
  persona("C03", "high-risk error prevention",
    ["sync_state_rejects_secrets", "credentials_encrypted_at_rest",
      "receipt_carries_no_secret", "credential_prompt_no_echo"],
    ["full error-envelope redaction (#3)"]),
  persona("C04", "long-flow interruption recovery",
    ["ambiguous_write_typed", "exact_id_readback_reconcile"],
    ["stdio interrupt/resume fixture (#4)"]),
  persona("C05", "SRE wanting bounded failures",
    ["provider_deadline", "caller_cancellation", "ci_workflow_declared"],
    ["stdio integration (#6)", "CI admission receipt (#5)"]),
  persona("D01", "manager reading a summary",
    ["ambiguous_write_typed"],
    ["handler-level receipt (#4)"]),
  persona("D02", "PM tracking operation responsibility",
    ["ambiguous_write_typed"],
    []),
  persona("D03", "IT admin deploying local MCP",
    ["credentials_encrypted_at_rest", "credential_prompt_no_echo"],
    ["supported-OS credential lifecycle (#3)"]),
  persona("D04", "cost-sensitive retry watcher",
    ["provider_deadline", "no_blind_write_retry"],
    ["real provider quota behavior"]),
  persona("D05", "compliance reviewer of secret handling",
    ["sync_state_rejects_secrets", "receipt_carries_no_secret", "credential_prompt_no_echo"],
    ["provider evidence (#3)"]),
  persona("E01", "office user on an external MCP client",
    ["exact_id_fast_path", "preview_is_default"],
    ["external MCP client + real provider"]),
  persona("E02", "desktop large-text user",
    [],
    ["client presentation/zoom"]),
  persona("E03", "low-confidence user fearing misclicks",
    ["preview_is_default", "credential_prompt_no_echo"],
    ["first-run auth"]),
  persona("E04", "Windows desktop local install",
    ["stdio_signal_exit"],
    ["Windows end-to-end"]),
  persona("E05", "long-session repeated saves",
    ["provider_deadline"],
    ["long-session resource behavior"]),
  persona("F01", "senior first-time user, helper-configured",
    ["exact_id_fast_path"],
    ["client usability"]),
  persona("F02", "low-vision user",
    [],
    ["assistive-technology client"]),
  persona("F03", "low hand-precision user",
    ["selected_video_binds"],
    ["client target size"]),
  persona("F04", "memory-sensitive user resuming after interruption",
    ["ambiguous_write_typed"],
    ["handler recovery (#4)"]),
  persona("F05", "daily exact-link saves after assisted setup",
    ["exact_id_fast_path", "credentials_encrypted_at_rest"],
    ["real refresh/revoke (#3)"]),
  persona("G01", "keyboard-only operator",
    [],
    ["keyboard-capable client"]),
  persona("G02", "screen-reader user hearing status",
    ["ambiguous_write_typed"],
    ["screen-reader client"]),
  persona("G03", "color-limited user reading status",
    ["ambiguous_write_typed"],
    ["client presentation"]),
  persona("G04", "200%-zoom narrow-window user",
    [],
    ["narrow/mobile client"]),
  persona("G05", "high-latency network user",
    ["provider_deadline", "caller_cancellation"],
    ["full stdio path (#6)"]),
  persona("H01", "Windows developer",
    ["credentials_encrypted_at_rest", "credential_prompt_no_echo"],
    ["Windows store/TTY (#3)"]),
  persona("H02", "macOS developer",
    ["credentials_encrypted_at_rest", "credential_prompt_no_echo"],
    ["macOS store/TTY (#3)"]),
  persona("H03", "Linux/CI non-interactive runner",
    ["stdio_signal_exit", "ci_workflow_declared"],
    ["CI admission receipt (#5)"]),
  persona("H04", "self-hosting deployer scoping the repo",
    [],
    []),
  persona("H05", "third-party maintainer verifying the repo",
    ["ci_workflow_declared"],
    []),
  persona("I01", "double-click re-submitter",
    ["exact_duplicate_no_rewrite"],
    ["ambiguous-retry reconcile (#4)"]),
  persona("I02", "process-kill recovery",
    ["exact_id_readback_reconcile"],
    ["stdio fixture (#4)"]),
  persona("I03", "bad-input submitter",
    ["invalid_input_rejected"],
    ["stdio error surface"]),
  persona("I04", "timeout/429/5xx caller",
    ["provider_deadline", "caller_cancellation", "no_blind_write_retry"],
    ["stdio/provider closure (#6)"]),
  persona("I05", "partial-success retrier",
    ["ambiguous_write_typed", "exact_id_readback_reconcile"],
    ["stdio fixture (#4)"]),
  persona("J01", "large-library operator",
    ["pagination_bounded"],
    ["large real provider load"]),
  persona("J02", "concurrent multi-caller",
    ["concurrent_save_serialized"],
    ["full concurrency reconciliation"]),
  persona("J03", "long-running host under provider stalls",
    ["provider_deadline"],
    ["long-run resource measurement"]),
  persona("J04", "privacy-sensitive credential owner",
    ["sync_state_rejects_secrets", "receipt_carries_no_secret", "credential_prompt_no_echo"],
    ["revoke/status real provider (#3)"]),
  persona("J05", "expert automating the shortest path",
    ["free_text_requires_selection", "exact_id_fast_path", "provider_deadline"],
    ["stdio integration (#6)"]),
]);

export async function runPersonaGate({ root = REPO_ROOT } = {}) {
  const needed = new Set(PERSONA_MATRIX.flatMap((p) => p.checks));
  const results = {};
  for (const checkId of needed) {
    const check = CHECKS[checkId];
    try {
      results[checkId] = {
        id: checkId,
        ok: true,
        detail: await check.run({ root }),
        issues: [...check.issues],
      };
    } catch (error) {
      results[checkId] = {
        id: checkId,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        issues: [...check.issues],
      };
    }
  }

  const personas = PERSONA_MATRIX.map((entry) => {
    const checks = entry.checks.map((checkId) => results[checkId]);
    const failed = checks.filter((check) => !check.ok);
    const untracked = failed.filter((check) => check.issues.length === 0);
    const status = untracked.length > 0
      ? "FAIL"
      : failed.length > 0
        ? "TRACKED"
        : entry.runtime.length > 0
          ? "NEEDS_RUNTIME"
          : "PASS";
    return {
      id: entry.id,
      label: entry.label,
      status,
      issues: [...new Set(failed.flatMap((check) => check.issues))].sort(),
      runtime: [...entry.runtime],
      checks,
    };
  });

  const count = (status) => personas.filter((p) => p.status === status).length;
  const summary = {
    total: personas.length,
    pass: count("PASS"),
    needsRuntime: count("NEEDS_RUNTIME"),
    tracked: count("TRACKED"),
    fail: count("FAIL"),
  };
  return {
    gate: "fixed-50-persona-a01-j05",
    spec: "Reese-max/autodev-ng docs/portfolio-audit/2026-09-06-50-persona-audit.md",
    generatedAt: new Date().toISOString(),
    personas,
    summary,
    verdict: summary.pass === summary.total ? "CLEAN" : "NOT_CLEAN",
  };
}

export function formatReport(report) {
  const lines = [
    `Fixed A01–J05 persona gate — verdict: ${report.verdict}`,
    "| Persona | Status | Issues | Checks | Runtime evidence still owed |",
    "|---|---|---|---|---|",
  ];
  for (const p of report.personas) {
    const failed = p.checks.filter((check) => !check.ok).map((check) => check.id).join(", ");
    lines.push(
      `| ${p.id} | ${p.status} | ${p.issues.join(", ") || "—"} | ${failed || "ok"} | ${p.runtime.join("; ") || "—"} |`,
    );
  }
  const { summary } = report;
  lines.push("");
  lines.push(
    `Summary: ${summary.pass} PASS / ${summary.tracked} TRACKED / ${summary.needsRuntime} NEEDS_RUNTIME / ${summary.fail} FAIL (total ${summary.total})`,
  );
  if (summary.fail > 0) {
    lines.push("FAIL = new reproducible defect with no tracker — the gate fails.");
  }
  return lines.join("\n") + "\n";
}

export async function main({ argv = [], out = process.stdout, root = REPO_ROOT } = {}) {
  const report = await runPersonaGate({ root });
  out.write(argv.includes("--json")
    ? JSON.stringify(report, null, 2) + "\n"
    : formatReport(report));
  if (argv.includes("--strict")) return report.verdict === "CLEAN" ? 0 : 1;
  return report.summary.fail > 0 ? 1 : 0;
}

const entry = process.argv[1] && path.resolve(process.argv[1]);
if (entry && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main({ argv: process.argv.slice(2) });
}

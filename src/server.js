import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import {
  classifyItems,
  classifyTrack,
  DEFAULT_RULES,
  findDuplicates,
  parseLink,
  parsePlaylistId,
} from "./core.js";
import { fetchYouTubeMetadata, SpotifyClient } from "./spotify.js";
import {
  parseYouTubePlaylistReference,
  youtubePlaylistUrl,
  YouTubeClient,
} from "./youtube.js";
import { openLibrary } from "./library.js";
import { classifyMusic } from "./classify.js";
import { saveMusic } from "./save-music.js";
import {
  getMusic,
  listMusic,
  listUnsyncedMusic,
  recentMusic,
  reclassifyMusic,
  removeMusic,
  searchLibrary,
  updateMusicTags,
} from "./library-query.js";
import { reconcileTrack, syncStatus, syncYoutube } from "./library-sync.js";
import { importMusicBatch, importStatus, previewImport } from "./batch-import.js";
import { exportLibrary, restoreLibrary } from "./library-backup.js";
import {
  deletePlaylist,
  getPlaylistAdmin,
  listPlaylistItemsAdmin,
  removeFromPlaylist,
  renamePlaylistAdmin,
} from "./playlist-admin.js";

const client = new SpotifyClient();
const youtubeClient = new YouTubeClient();

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  const payload = {
    error: error instanceof Error ? error.message : String(error),
  };
  if (typeof error?.code === "string") payload.code = error.code;
  if (Number.isInteger(error?.status)) payload.status = error.status;
  if (typeof error?.retryable === "boolean") payload.retryable = error.retryable;
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  };
}

function safeTool(handler) {
  return async (args, extra) => {
    try {
      return jsonResult(await handler(args, extra));
    } catch (error) {
      return errorResult(error);
    }
  };
}

async function loadPlaylist(playlist, { signal } = {}) {
  const id = parsePlaylistId(playlist);
  const [details, items] = await Promise.all([
    client.getPlaylist(id, { signal }),
    client.getPlaylistItems(id, { signal }),
  ]);
  return { id, details, items };
}

function playlistUrl(id) {
  return "https://open.spotify.com/playlist/" + id;
}

function boundedName(name) {
  return String(name).trim().slice(0, 100);
}

function catalogQuery(value) {
  const compact = value.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(compact) ? "isrc:" + compact : value;
}

async function replaceWithChunks(id, uris, { signal } = {}) {
  await client.replacePlaylistItems(id, uris.slice(0, 100), { signal });
  for (let offset = 100; offset < uris.length; offset += 100) {
    await client.addPlaylistItems(id, uris.slice(offset, offset + 100), { signal });
  }
}

async function loadYouTubePlaylist(reference, { allowMissing = false, signal } = {}) {
  const parsed = parseYouTubePlaylistReference(reference);
  if (parsed.id) {
    const [details, items] = await Promise.all([
      youtubeClient.getPlaylist(parsed.id, { signal }),
      youtubeClient.getPlaylistItems(parsed.id, { signal }),
    ]);
    return { id: parsed.id, details, items };
  }

  const available = await youtubeClient.listPlaylists({ limit: 500, signal });
  const match = available.playlists.find(
    (playlist) => playlist.name.trim().toLocaleLowerCase() === parsed.name.trim().toLocaleLowerCase(),
  );
  if (!match) {
    if (allowMissing) return { id: null, details: { name: parsed.name }, items: [], name: parsed.name };
    throw new Error("YouTube playlist was not found by name: " + parsed.name);
  }
  return {
    id: match.id,
    details: match,
    items: await youtubeClient.getPlaylistItems(match.id, { signal }),
  };
}

async function resolveYouTubeMatch(input, { limit = 5, regionCode, signal, videoId } = {}) {
  if (videoId) {
    return {
      source: {
        kind: "youtube-video-selection",
        id: videoId,
        url: "https://www.youtube.com/watch?v=" + videoId,
        input,
      },
      match: await youtubeClient.getVideo(videoId, { signal }),
    };
  }
  const source = parseLink(input);
  if (source.kind === "youtube-video") {
    return { source, match: await youtubeClient.getVideo(source.id, { signal }) };
  }
  if (source.kind === "youtube-playlist") {
    throw new Error("The supplied YouTube link is a playlist; provide a video link instead.");
  }

  const search = await youtubeClient.searchVideos(input, { limit, regionCode, signal });
  const match = search.videos[0];
  if (!match) throw new Error("No YouTube video matched the supplied input.");
  return { source, match, candidates: search.videos };
}

function youtubePlaylistInfo(loaded, fallbackName = null) {
  const name = loaded.details?.name ?? loaded.name ?? fallbackName;
  return {
    id: loaded.id,
    name,
    url: loaded.id ? youtubePlaylistUrl(loaded.id) : null,
  };
}

function youtubeDuplicate(loaded, videoId) {
  return loaded.items.find((item) => item.id === videoId) ?? null;
}

export function createServer(library) {
  const server = new McpServer({ name: "music-playlist-organizer", version: "0.2.0" });

  server.registerTool(
    "library_status",
    {
      description: "Report the local music library path, schema version, and track count. Never returns secrets or row contents.",
      inputSchema: z.object({}),
    },
    safeTool(() => library.status()),
  );

  server.registerTool(
    "spotify_search_tracks",
    {
      description: "Search the Spotify catalog for tracks by title, artist, album, or free text.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
        market: z.string().regex(/^[A-Za-z]{2}$/).optional(),
      }),
    },
    safeTool(({ query, limit, market }, extra) => (
      client.searchTracks(query, { limit, market, signal: extra?.signal })
    )),
  );

  server.registerTool(
    "spotify_identify_track",
    {
      description: "Identify a track from a Spotify link, YouTube link, ISRC/search text, or title and artist.",
      inputSchema: z.object({
        input: z.string().min(1),
        artist: z.string().optional(),
        limit: z.number().int().min(1).max(10).default(5),
        market: z.string().regex(/^[A-Za-z]{2}$/).optional(),
      }),
    },
    safeTool(async ({ input, artist, limit, market }, extra) => {
      const source = parseLink(input);
      if (source.kind === "spotify-track") {
        return { source, match: await client.getTrack(source.id, market, { signal: extra?.signal }) };
      }
      if (source.kind === "spotify-playlist") {
        throw new Error("The supplied Spotify link is a playlist; provide a track link instead.");
      }

      let query = catalogQuery(source.query ?? input);
      let youtube = null;
      if (source.kind === "youtube-video") {
        youtube = await fetchYouTubeMetadata(source.url, globalThis.fetch, { signal: extra?.signal });
        query = [youtube.title, youtube.author].filter(Boolean).join(" ");
      }
      if (artist) query = (query + " " + artist).trim();
      return {
        source,
        youtube,
        ...(await client.searchTracks(query, { limit, market, signal: extra?.signal })),
      };
    }),
  );

  server.registerTool(
    "spotify_resolve_links",
    {
      description: "Resolve a batch of Spotify or YouTube links into Spotify track candidates.",
      inputSchema: z.object({
        links: z.array(z.string().min(1)).min(1).max(50),
        market: z.string().regex(/^[A-Za-z]{2}$/).optional(),
      }),
    },
    safeTool(async ({ links, market }, extra) => {
      const results = [];
      for (const input of links) {
        try {
          const source = parseLink(input);
          if (source.kind === "spotify-track") {
            results.push({
              input,
              source,
              match: await client.getTrack(source.id, market, { signal: extra?.signal }),
            });
            continue;
          }
          if (source.kind === "spotify-playlist" || source.kind === "youtube-playlist") {
            results.push({ input, source, error: "A playlist link is not a single track." });
            continue;
          }
          let query = catalogQuery(source.query ?? input);
          let youtube = null;
          if (source.kind === "youtube-video") {
            youtube = await fetchYouTubeMetadata(source.url, globalThis.fetch, { signal: extra?.signal });
            query = [youtube.title, youtube.author].filter(Boolean).join(" ");
          }
          results.push({
            input,
            source,
            youtube,
            ...(await client.searchTracks(query, { limit: 5, market, signal: extra?.signal })),
          });
        } catch (error) {
          results.push({ input, error: error instanceof Error ? error.message : String(error) });
        }
      }
      return { results };
    }),
  );

  server.registerTool(
    "spotify_check_playlist_duplicates",
    {
      description: "Find repeated tracks in a Spotify playlist without changing it.",
      inputSchema: z.object({ playlist: z.string().min(1) }),
    },
    safeTool(async ({ playlist }, extra) => {
      const loaded = await loadPlaylist(playlist, { signal: extra?.signal });
      return {
        playlist: {
          id: loaded.id,
          name: loaded.details.name,
          url: loaded.details.external_urls?.spotify ?? playlistUrl(loaded.id),
        },
        ...findDuplicates(loaded.items),
      };
    }),
  );

  server.registerTool(
    "spotify_classify_playlist",
    {
      description: "Preview deterministic playlist categories using title, artist, and album keywords.",
      inputSchema: z.object({
        playlist: z.string().min(1),
        rules: z.record(z.string(), z.array(z.string())).optional(),
      }),
    },
    safeTool(async ({ playlist, rules }, extra) => {
      const loaded = await loadPlaylist(playlist, { signal: extra?.signal });
      const classification = classifyItems(loaded.items, rules ?? DEFAULT_RULES);
      return {
        mode: "preview",
        playlist: {
          id: loaded.id,
          name: loaded.details.name,
          url: loaded.details.external_urls?.spotify ?? playlistUrl(loaded.id),
        },
        ...classification,
      };
    }),
  );

  server.registerTool(
    "spotify_organize_playlist",
    {
      description: "Preview or apply category playlists derived from a source Spotify playlist. Apply replaces only matching derived playlists.",
      inputSchema: z.object({
        playlist: z.string().min(1),
        mode: z.enum(["preview", "apply"]).default("preview"),
        rules: z.record(z.string(), z.array(z.string())).optional(),
        public: z.boolean().default(false),
        prefix: z.string().max(40).default(""),
      }),
    },
    safeTool(async ({ playlist, mode, rules, public: isPublic, prefix }, extra) => {
      const loaded = await loadPlaylist(playlist, { signal: extra?.signal });
      const classification = classifyItems(loaded.items, rules ?? DEFAULT_RULES);
      const plan = Object.entries(classification.categories)
        .map(([category, tracks]) => ({
          category,
          count: tracks.length,
          uris: tracks.map((track) => track.uri).filter((uri) => uri?.startsWith("spotify:track:")),
          name: boundedName((prefix ? prefix + " · " : "") + category + " · " + loaded.details.name),
        }))
        .filter((entry) => entry.uris.length > 0);

      if (mode === "preview") {
        return {
          mode,
          playlist: { id: loaded.id, name: loaded.details.name, url: playlistUrl(loaded.id) },
          plan: plan.map(({ uris, ...entry }) => ({ ...entry, trackCount: uris.length })),
        };
      }

      const user = await client.getCurrentUser({ signal: extra?.signal });
      const currentPlaylists = await client.listCurrentUserPlaylists({ signal: extra?.signal });
      const results = [];
      for (const entry of plan) {
        const existing = currentPlaylists.find(
          (candidate) => candidate.owner?.id === user.id && candidate.name === entry.name,
        );
        const target = existing ?? await client.createPlaylist(
          user.id,
          entry.name,
          "Derived from " + loaded.details.name + " by music-playlist-organizer-mcp",
          isPublic,
          { signal: extra?.signal },
        );
        await replaceWithChunks(target.id, entry.uris, { signal: extra?.signal });
        results.push({
          category: entry.category,
          trackCount: entry.uris.length,
          playlist: {
            id: target.id,
            name: target.name ?? entry.name,
            url: target.external_urls?.spotify ?? playlistUrl(target.id),
            action: existing ? "updated" : "created",
          },
        });
      }

      return {
        mode,
        sourcePlaylist: { id: loaded.id, name: loaded.details.name, url: playlistUrl(loaded.id) },
        results,
        note: "Only derived playlists with the exact generated name were updated; the source playlist was not changed.",
      };
    }),
  );

  server.registerTool(
    "youtube_search_videos",
    {
      description: "Search YouTube or YouTube Music-compatible video links by song title, artist, or free text.",
      inputSchema: z.object({
        query: z.string().min(1),
        limit: z.number().int().min(1).max(50).default(10),
        regionCode: z.string().regex(/^[A-Za-z]{2}$/).optional(),
        order: z.enum(["relevance", "date", "rating", "title", "viewCount"]).default("relevance"),
      }),
    },
    safeTool(({ query, limit, regionCode, order }, extra) => (
      youtubeClient.searchVideos(query, { limit, regionCode, order, signal: extra?.signal })
    )),
  );

  server.registerTool(
    "youtube_identify_track",
    {
      description: "Identify a song/video from a YouTube URL, YouTube Music URL, video ID, or search text.",
      inputSchema: z.object({
        input: z.string().min(1),
        limit: z.number().int().min(1).max(10).default(5),
        regionCode: z.string().regex(/^[A-Za-z]{2}$/).optional(),
      }),
    },
    safeTool(async ({ input, limit, regionCode }, extra) => (
      resolveYouTubeMatch(input, { limit, regionCode, signal: extra?.signal })
    )),
  );

  server.registerTool(
    "youtube_resolve_links",
    {
      description: "Resolve multiple YouTube or YouTube Music links/searches into video candidates.",
      inputSchema: z.object({
        links: z.array(z.string().min(1)).min(1).max(50),
        regionCode: z.string().regex(/^[A-Za-z]{2}$/).optional(),
      }),
    },
    safeTool(async ({ links, regionCode }, extra) => {
      const results = [];
      for (const input of links) {
        try {
          results.push({
            input,
            ...(await resolveYouTubeMatch(input, { limit: 5, regionCode, signal: extra?.signal })),
          });
        } catch (error) {
          if (error?.code === "CALLER_CANCELLED") throw error;
          results.push({
            input,
            error: error instanceof Error ? error.message : String(error),
            ...(typeof error?.code === "string" ? { code: error.code } : {}),
            ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
          });
        }
      }
      return { results };
    }),
  );

  server.registerTool(
    "youtube_list_playlists",
    {
      description: "List the authenticated user's YouTube playlists.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(500).default(100),
      }),
    },
    safeTool(({ limit }, extra) => youtubeClient.listPlaylists({ limit, signal: extra?.signal })),
  );

  server.registerTool(
    "youtube_create_playlist",
    {
      description: "Create a YouTube playlist for the authenticated user.",
      inputSchema: z.object({
        name: z.string().min(1).max(150),
        description: z.string().max(5000).default(""),
        privacyStatus: z.enum(["private", "unlisted", "public"]).default("private"),
      }),
    },
    safeTool(({ name, description, privacyStatus }, extra) => (
      youtubeClient.createPlaylist(name, description, privacyStatus, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "youtube_auth_status",
    {
      description: "Report YouTube credential status without exposing any token or secret.",
      inputSchema: z.object({}),
    },
    safeTool(() => youtubeClient.credentialStatus()),
  );

  server.registerTool(
    "youtube_auth_revoke",
    {
      description: "Revoke the YouTube OAuth credential and delete the encrypted local credential record.",
      inputSchema: z.object({}),
    },
    safeTool((_, extra) => youtubeClient.revokeUserCredentials({ signal: extra?.signal })),
  );

  server.registerTool(
    "youtube_check_playlist_duplicates",
    {
      description: "Find repeated videos in a YouTube playlist without changing it.",
      inputSchema: z.object({ playlist: z.string().min(1) }),
    },
    safeTool(async ({ playlist }, extra) => {
      const loaded = await loadYouTubePlaylist(playlist, { signal: extra?.signal });
      return {
        playlist: youtubePlaylistInfo(loaded, playlist),
        ...findDuplicates(loaded.items),
      };
    }),
  );

  server.registerTool(
    "youtube_classify_playlist",
    {
      description: "Preview deterministic categories for a YouTube playlist using title and channel keywords.",
      inputSchema: z.object({
        playlist: z.string().min(1),
        rules: z.record(z.string(), z.array(z.string())).optional(),
      }),
    },
    safeTool(async ({ playlist, rules }, extra) => {
      const loaded = await loadYouTubePlaylist(playlist, { signal: extra?.signal });
      return {
        mode: "preview",
        playlist: youtubePlaylistInfo(loaded, playlist),
        ...classifyItems(loaded.items, rules ?? DEFAULT_RULES),
      };
    }),
  );

  server.registerTool(
    "youtube_add_to_playlist",
    {
      description: "Preview or add one YouTube video to an existing playlist, skipping an exact duplicate.",
      inputSchema: z.object({
        input: z.string().min(1),
        videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
        playlist: z.string().min(1),
        mode: z.enum(["preview", "apply"]).default("preview"),
      }),
    },
    safeTool(async ({ input, videoId, playlist, mode }, extra) => {
      const resolved = await resolveYouTubeMatch(input, { limit: 5, signal: extra?.signal, videoId });
      if (mode === "apply" && resolved.source.kind === "query" && !videoId) {
        return {
          mode,
          source: resolved.source,
          candidates: resolved.candidates,
          action: "selection_required",
          message: "Free-text apply requires videoId from the selected preview candidate.",
        };
      }
      const loaded = await loadYouTubePlaylist(playlist, { signal: extra?.signal });
      const duplicate = youtubeDuplicate(loaded, resolved.match.id);
      const result = {
        mode,
        source: resolved.source,
        video: resolved.match,
        playlist: youtubePlaylistInfo(loaded, playlist),
        duplicate: Boolean(duplicate),
        existingItem: duplicate,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      };
      if (mode === "preview" || duplicate) {
        return {
          ...result,
          action: duplicate ? "skipped_duplicate" : "would_add",
        };
      }
      try {
        await youtubeClient.addVideoToPlaylist(loaded.id, resolved.match.id, { signal: extra?.signal });
        return { ...result, action: "added" };
      } catch (error) {
        const ambiguous = ["TIMEOUT", "CALLER_CANCELLED", "NETWORK_ERROR"].includes(error?.code)
          || error?.status === 429
          || error?.status >= 500;
        return {
          ...result,
          action: "reconciliation_required",
          writeState: ambiguous ? "UNKNOWN_AFTER_WRITE" : "FAILED_NO_CONFIRMED_EFFECT",
          completedSteps: [],
          error: {
            code: error?.code ?? "WRITE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
          },
          nextStep: "Re-run with the exact playlist ID and video ID; check the playlist before adding again.",
        };
      }
    }),
  );

  server.registerTool(
    "youtube_save_track",
    {
      description: "Identify a YouTube song/video, classify it, deduplicate it, and add it to a named or category playlist.",
      inputSchema: z.object({
        input: z.string().min(1),
        videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
        playlist: z.string().min(1).optional(),
        category: z.string().min(1).max(80).optional(),
        mode: z.enum(["preview", "apply"]).default("preview"),
        rules: z.record(z.string(), z.array(z.string())).optional(),
        prefix: z.string().max(40).default(""),
        createIfMissing: z.boolean().default(true),
        privacyStatus: z.enum(["private", "unlisted", "public"]).default("private"),
        dedupe: z.boolean().default(true),
      }),
    },
    safeTool(async ({
      input,
      videoId,
      playlist,
      category,
      mode,
      rules,
      prefix,
      createIfMissing,
      privacyStatus,
      dedupe,
    }, extra) => {
      const resolved = await resolveYouTubeMatch(input, { limit: 5, signal: extra?.signal, videoId });
      if (mode === "apply" && resolved.source.kind === "query" && !videoId) {
        return {
          mode,
          source: resolved.source,
          candidates: resolved.candidates,
          action: "selection_required",
          message: "Free-text apply requires videoId from the selected preview candidate.",
        };
      }
      const selectedCategory = category ?? classifyTrack(resolved.match, rules ?? DEFAULT_RULES);
      const effectivePrefix = prefix || youtubeClient.env.YOUTUBE_PLAYLIST_PREFIX || "";
      const generatedName = boundedName((effectivePrefix ? effectivePrefix + " · " : "") + selectedCategory);
      const targetReference = playlist ?? generatedName;
      const loaded = await loadYouTubePlaylist(targetReference, {
        allowMissing: true,
        signal: extra?.signal,
      });
      const duplicate = loaded.id ? youtubeDuplicate(loaded, resolved.match.id) : null;
      const targetName = loaded.details?.name ?? loaded.name ?? targetReference;
      const preview = {
        mode,
        source: resolved.source,
        video: resolved.match,
        category: selectedCategory,
        playlist: youtubePlaylistInfo(loaded, targetName),
        playlistAction: loaded.id ? "use_existing" : "create_if_missing",
        duplicate: Boolean(duplicate),
        existingItem: duplicate,
        dedupe,
        ...(resolved.candidates ? { candidates: resolved.candidates } : {}),
      };

      if (mode === "preview") {
        return { ...preview, action: duplicate && dedupe ? "would_skip_duplicate" : "would_add" };
      }
      if (!loaded.id && !createIfMissing) {
        throw new Error("The target YouTube playlist does not exist and createIfMissing is false.");
      }
      if (duplicate && dedupe) {
        return { ...preview, action: "skipped_duplicate" };
      }

      let target = loaded;
      let createdPlaylist = false;
      try {
        if (!target.id) {
          const created = await youtubeClient.createPlaylist(
            targetName,
            "Managed by music-playlist-organizer-mcp. Category: " + selectedCategory,
            privacyStatus,
            { signal: extra?.signal },
          );
          target = { id: created.id, details: created, items: [] };
          createdPlaylist = true;
        }
        await youtubeClient.addVideoToPlaylist(target.id, resolved.match.id, { signal: extra?.signal });
      } catch (error) {
        const ambiguous = ["TIMEOUT", "CALLER_CANCELLED", "NETWORK_ERROR"].includes(error?.code)
          || error?.status === 429
          || error?.status >= 500;
        return {
          ...preview,
          playlist: youtubePlaylistInfo(target, targetName),
          playlistAction: createdPlaylist ? "created" : loaded.id ? "use_existing" : "unknown",
          videoId: resolved.match.id,
          completedSteps: createdPlaylist ? ["playlist_created"] : [],
          writeState: ambiguous
            ? "UNKNOWN_AFTER_WRITE"
            : createdPlaylist
              ? "PARTIAL_PLAYLIST_CREATED"
              : "FAILED_NO_CONFIRMED_EFFECT",
          action: "reconciliation_required",
          error: {
            code: error?.code ?? "WRITE_FAILED",
            message: error instanceof Error ? error.message : String(error),
            ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
          },
          nextStep: createdPlaylist
            ? "Use the returned playlist ID, read its items, and only retry if the exact video ID is absent."
            : "Read the target playlist by exact ID before retrying; do not create another playlist.",
        };
      }
      return {
        ...preview,
        mode,
        playlist: youtubePlaylistInfo(target, targetName),
        playlistAction: loaded.id ? "use_existing" : "created",
        action: "added",
      };
    }),
  );

  server.registerTool(
    "save_music",
    {
      description: "Unified entry point: identify a song from a name or YouTube/YouTube Music link, canonicalize, dedupe, classify, save to the local music library, and optionally sync to a YouTube playlist. Returns a complete receipt; previews by default.",
      inputSchema: z.object({
        input: z.string().min(1),
        videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
        tags: z.array(z.string().min(1).max(200)).max(50).optional(),
        category: z.string().min(1).max(80).optional(),
        playlist: z.string().min(1).optional(),
        mode: z.enum(["preview", "apply"]).default("preview"),
        syncToYouTube: z.boolean().default(true),
      }),
    },
    safeTool((args, extra) => (
      saveMusic({ youtube: youtubeClient, library }, args, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "classify_track",
    {
      description: "Preview multi-dimensional music classification (genre, mood, language, activity, energy, era, artist, custom_tags) with per-value source and confidence. Read-only; writes nothing.",
      inputSchema: z.object({
        title: z.string().min(1),
        artist: z.string().optional(),
        channelTitle: z.string().optional(),
        description: z.string().optional(),
        userClassification: z.object({
          genre: z.union([z.string(), z.array(z.string())]).optional(),
          mood: z.union([z.string(), z.array(z.string())]).optional(),
          language: z.union([z.string(), z.array(z.string())]).optional(),
          activity: z.union([z.string(), z.array(z.string())]).optional(),
          energy: z.union([z.string(), z.array(z.string())]).optional(),
          era: z.union([z.string(), z.array(z.string())]).optional(),
          artist: z.union([z.string(), z.array(z.string())]).optional(),
          custom_tags: z.union([z.string(), z.array(z.string())]).optional(),
        }).optional(),
      }),
    },
    safeTool(async (args) => ({ mode: "preview", ...(await classifyMusic(args)) })),
  );

  const pagingSchema = {
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).default(0),
  };

  server.registerTool(
    "search_library",
    {
      description: "Read-only search of the local music library by title, artist, tag, genre, mood, language, or activity. Bounded pagination.",
      inputSchema: z.object({
        title: z.string().min(1).optional(),
        artist: z.string().min(1).optional(),
        tag: z.string().min(1).optional(),
        genre: z.string().min(1).optional(),
        mood: z.string().min(1).optional(),
        language: z.string().min(1).optional(),
        activity: z.string().min(1).optional(),
        ...pagingSchema,
      }),
    },
    safeTool((args) => searchLibrary(library, args)),
  );

  server.registerTool(
    "list_music",
    {
      description: "Read-only listing of the local music library, newest first, with bounded pagination.",
      inputSchema: z.object({ ...pagingSchema }),
    },
    safeTool((args) => listMusic(library, args)),
  );

  server.registerTool(
    "recent_music",
    {
      description: "Read-only list of the most recently saved library tracks. Bounded limit.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).default(20),
      }),
    },
    safeTool((args) => recentMusic(library, args)),
  );

  server.registerTool(
    "get_music",
    {
      description: "Read a single library track by its local track ID: canonical fields, sources, tags, playlists, stored classification, and sync state.",
      inputSchema: z.object({
        trackId: z.number().int().min(1),
      }),
    },
    safeTool((args) => getMusic(library, args)),
  );

  server.registerTool(
    "update_music_tags",
    {
      description: "Add and/or remove custom tags on one library track. Never overwrites classification dimensions or user-set metadata.",
      inputSchema: z.object({
        trackId: z.number().int().min(1),
        add: z.array(z.string().min(1).max(200)).max(50).optional(),
        remove: z.array(z.string().min(1).max(200)).max(50).optional(),
      }),
    },
    safeTool((args) => updateMusicTags(library, args)),
  );

  server.registerTool(
    "reclassify_music",
    {
      description: "Re-run automatic classification for one library track. User-set dimensions and tags are preserved; returns the before/after diff.",
      inputSchema: z.object({
        trackId: z.number().int().min(1),
      }),
    },
    safeTool((args) => reclassifyMusic(library, args)),
  );

  server.registerTool(
    "remove_music",
    {
      description: "Preview or apply removal of a library track. Local deletion and YouTube playlist-item deletion are independent effects: each must be authorized explicitly and is reported separately.",
      inputSchema: z.object({
        trackId: z.number().int().min(1),
        mode: z.enum(["preview", "apply"]).default("preview"),
        local: z.boolean().default(false),
        youtubePlaylist: z.string().min(1).optional(),
        videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
      }),
    },
    safeTool((args, extra) => (
      removeMusic({ library, youtube: youtubeClient }, args, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "list_unsynced_music",
    {
      description: "Read-only list of library tracks needing attention: not synced to any provider playlist, identity conflicts, or provider-unavailable sync markers.",
      inputSchema: z.object({
        reason: z.enum(["not_synced", "identity_conflict", "provider_unavailable"]).optional(),
        ...pagingSchema,
      }),
    },
    safeTool((args) => listUnsyncedMusic(library, args)),
  );

  server.registerTool(
    "sync_status",
    {
      description: "Read-only scan comparing the local library with managed YouTube playlists. Reports per-track status (in_sync, local_only, conflict, unknown_after_write, unknown) and per-video status (youtube_only, unlinked, unavailable).",
      inputSchema: z.object({
        playlist: z.string().min(1).optional(),
      }),
    },
    safeTool((args, extra) => (
      syncStatus({ library, youtube: youtubeClient }, args, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "sync_youtube",
    {
      description: "Preview or apply synchronization between the library and YouTube. direction=push adds missing local tracks to playlists (and optionally removes unknown remote items when allowRemoval=true); pull imports YouTube-only videos into the library; reconcile repairs local sync state (playlist renames, unavailable sources, unlinked memberships, unknown_after_write markers) without provider writes.",
      inputSchema: z.object({
        mode: z.enum(["preview", "apply"]).default("preview"),
        direction: z.enum(["push", "pull", "reconcile"]).default("push"),
        playlist: z.string().min(1).optional(),
        allowRemoval: z.boolean().default(false),
      }),
    },
    safeTool((args, extra) => (
      syncYoutube({ library, youtube: youtubeClient }, args, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "reconcile_track",
    {
      description: "Exact-ID read-back for one library track (or youtube videoId): checks each source against the provider, marks deleted/private videos unavailable without deleting the canonical track, and resolves unknown_after_write markers to synced/local_only/unavailable.",
      inputSchema: z.object({
        trackId: z.number().int().min(1).optional(),
        videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/).optional(),
        playlistId: z.string().min(1).optional(),
      }),
    },
    safeTool((args, extra) => (
      reconcileTrack({ library, youtube: youtubeClient }, args, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "preview_import",
    {
      description: "Resolve a mixed batch of YouTube/YouTube Music video URLs, video IDs, free-text lines, and/or one playlist URL/ID into an import plan (new/exact_duplicate/canonical_duplicate/unresolved/unavailable). Writes nothing; stores the plan under a batchId for import_music_batch.",
      inputSchema: z.object({
        items: z.array(z.string().min(1)).max(2000).optional(),
        playlist: z.string().min(1).optional(),
        syncPlaylist: z.string().min(1).optional(),
      }),
    },
    safeTool((args, extra) => (
      previewImport({ library, youtube: youtubeClient }, args, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "import_music_batch",
    {
      description: "Apply an import plan — pass the same inputs as preview_import or a batchId (with resume:true to continue a cancelled batch). Only resolved items are written; per-item results are returned and re-runs are idempotent. YouTube playlist writes happen only when syncPlaylist is passed explicitly.",
      inputSchema: z.object({
        items: z.array(z.string().min(1)).max(2000).optional(),
        playlist: z.string().min(1).optional(),
        batchId: z.string().min(1).optional(),
        resume: z.boolean().default(false),
        syncPlaylist: z.string().min(1).optional(),
      }),
    },
    safeTool((args, extra) => (
      importMusicBatch({ library, youtube: youtubeClient }, args, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "import_status",
    {
      description: "Read-only progress of a stored import batch: total counts plus done/pending item tallies.",
      inputSchema: z.object({
        batchId: z.string().min(1),
      }),
    },
    safeTool((args) => importStatus(library, args)),
  );

  server.registerTool(
    "export_library",
    {
      description: "Export the entire Personal Music Library as versioned JSON (lossless) or CSV (readable, lossy). Never includes OAuth tokens, refresh tokens, client secrets, or the credential passphrase.",
      inputSchema: z.object({
        format: z.enum(["json", "csv"]).default("json"),
      }),
    },
    safeTool((args) => ({ format: args.format, content: exportLibrary(library, { format: args.format }) })),
  );

  server.registerTool(
    "restore_library",
    {
      description: "Restore a versioned JSON backup produced by export_library. Default preview reports insert/update/unchanged/conflict/unsupported counts; apply writes inside one transaction. Restores no provider state — run sync_youtube afterwards to reconcile.",
      inputSchema: z.object({
        backup: z.union([z.string().min(1), z.record(z.unknown())]),
        mode: z.enum(["preview", "apply"]).default("preview"),
      }),
    },
    safeTool((args) => restoreLibrary(library, args.backup, { mode: args.mode })),
  );

  server.registerTool(
    "youtube_get_playlist",
    {
      description: "Read-only playlist metadata by exact playlist ID or URL.",
      inputSchema: z.object({
        playlist: z.string().min(1),
      }),
    },
    safeTool((args, extra) => (
      getPlaylistAdmin({ youtube: youtubeClient }, args, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "youtube_list_playlist_items",
    {
      description: "Read-only bounded listing of playlist items by exact playlist ID or URL.",
      inputSchema: z.object({
        playlist: z.string().min(1),
        ...pagingSchema,
      }),
    },
    safeTool((args, extra) => (
      listPlaylistItemsAdmin({ youtube: youtubeClient }, args, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "youtube_rename_playlist",
    {
      description: "Rename a playlist by exact ID. Preview shows old/new names; apply verifies the result by exact-ID read-back and reports RENAMED or UNKNOWN_AFTER_WRITE.",
      inputSchema: z.object({
        playlist: z.string().min(1),
        name: z.string().min(1).max(150),
        mode: z.enum(["preview", "apply"]).default("preview"),
      }),
    },
    safeTool((args, extra) => (
      renamePlaylistAdmin({ youtube: youtubeClient }, args, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "youtube_remove_from_playlist",
    {
      description: "Remove one item from a playlist by exact playlist ID + videoId. Provider-only effect — the Personal Library canonical track is untouched. Apply verifies removal by read-back.",
      inputSchema: z.object({
        playlist: z.string().min(1),
        videoId: z.string().min(1),
        mode: z.enum(["preview", "apply"]).default("preview"),
      }),
    },
    safeTool((args, extra) => (
      removeFromPlaylist({ youtube: youtubeClient }, args, { signal: extra?.signal })
    )),
  );

  server.registerTool(
    "youtube_delete_playlist",
    {
      description: "Permanently delete a playlist. Preview reports exact ID, name, and item count; apply requires confirmPlaylistId equal to the exact playlist ID. Never triggered implicitly by sync or cleanup.",
      inputSchema: z.object({
        playlist: z.string().min(1),
        mode: z.enum(["preview", "apply"]).default("preview"),
        confirmPlaylistId: z.string().min(1).optional(),
      }),
    },
    safeTool((args, extra) => (
      deletePlaylist({ youtube: youtubeClient }, args, { signal: extra?.signal })
    )),
  );

  return server;
}

export async function main(env = process.env) {
  const library = openLibrary(env);
  const server = createServer(library);
  const transport = new StdioServerTransport();
  const shutdown = () => {
    try { library.close(); } catch {}
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  process.stdin.once("end", shutdown);
  process.stdin.once("close", shutdown);
  await server.connect(transport);
  return { library, server, transport };
}

const entry = process.argv[1] && path.resolve(process.argv[1]);
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}

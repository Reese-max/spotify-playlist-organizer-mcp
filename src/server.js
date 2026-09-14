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

const client = new SpotifyClient();
const youtubeClient = new YouTubeClient();

function jsonResult(value) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

function errorResult(error) {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }) }],
  };
}

function safeTool(handler) {
  return async (args) => {
    try {
      return jsonResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}

async function loadPlaylist(playlist) {
  const id = parsePlaylistId(playlist);
  const [details, items] = await Promise.all([
    client.getPlaylist(id),
    client.getPlaylistItems(id),
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

async function replaceWithChunks(id, uris) {
  await client.replacePlaylistItems(id, uris.slice(0, 100));
  for (let offset = 100; offset < uris.length; offset += 100) {
    await client.addPlaylistItems(id, uris.slice(offset, offset + 100));
  }
}

async function loadYouTubePlaylist(reference, { allowMissing = false } = {}) {
  const parsed = parseYouTubePlaylistReference(reference);
  if (parsed.id) {
    const [details, items] = await Promise.all([
      youtubeClient.getPlaylist(parsed.id),
      youtubeClient.getPlaylistItems(parsed.id),
    ]);
    return { id: parsed.id, details, items };
  }

  const available = await youtubeClient.listPlaylists({ limit: 500 });
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
    items: await youtubeClient.getPlaylistItems(match.id),
  };
}

async function resolveYouTubeMatch(input, { limit = 5, regionCode } = {}) {
  const source = parseLink(input);
  if (source.kind === "youtube-video") {
    return { source, match: await youtubeClient.getVideo(source.id) };
  }
  if (source.kind === "youtube-playlist") {
    throw new Error("The supplied YouTube link is a playlist; provide a video link instead.");
  }

  const search = await youtubeClient.searchVideos(input, { limit, regionCode });
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

function createServer() {
  const server = new McpServer({ name: "music-playlist-organizer", version: "0.2.0" });

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
    safeTool(({ query, limit, market }) => client.searchTracks(query, { limit, market })),
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
    safeTool(async ({ input, artist, limit, market }) => {
      const source = parseLink(input);
      if (source.kind === "spotify-track") {
        return { source, match: await client.getTrack(source.id, market) };
      }
      if (source.kind === "spotify-playlist") {
        throw new Error("The supplied Spotify link is a playlist; provide a track link instead.");
      }

      let query = catalogQuery(source.query ?? input);
      let youtube = null;
      if (source.kind === "youtube-video") {
        youtube = await fetchYouTubeMetadata(source.url);
        query = [youtube.title, youtube.author].filter(Boolean).join(" ");
      }
      if (artist) query = (query + " " + artist).trim();
      return { source, youtube, ...(await client.searchTracks(query, { limit, market })) };
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
    safeTool(async ({ links, market }) => {
      const results = [];
      for (const input of links) {
        try {
          const source = parseLink(input);
          if (source.kind === "spotify-track") {
            results.push({ input, source, match: await client.getTrack(source.id, market) });
            continue;
          }
          if (source.kind === "spotify-playlist" || source.kind === "youtube-playlist") {
            results.push({ input, source, error: "A playlist link is not a single track." });
            continue;
          }
          let query = catalogQuery(source.query ?? input);
          let youtube = null;
          if (source.kind === "youtube-video") {
            youtube = await fetchYouTubeMetadata(source.url);
            query = [youtube.title, youtube.author].filter(Boolean).join(" ");
          }
          results.push({ input, source, youtube, ...(await client.searchTracks(query, { limit: 5, market })) });
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
    safeTool(async ({ playlist }) => {
      const loaded = await loadPlaylist(playlist);
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
    safeTool(async ({ playlist, rules }) => {
      const loaded = await loadPlaylist(playlist);
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
    safeTool(async ({ playlist, mode, rules, public: isPublic, prefix }) => {
      const loaded = await loadPlaylist(playlist);
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

      const user = await client.getCurrentUser();
      const currentPlaylists = await client.listCurrentUserPlaylists();
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
        );
        await replaceWithChunks(target.id, entry.uris);
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
    safeTool(({ query, limit, regionCode, order }) => youtubeClient.searchVideos(query, { limit, regionCode, order })),
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
    safeTool(async ({ input, limit, regionCode }) => resolveYouTubeMatch(input, { limit, regionCode })),
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
    safeTool(async ({ links, regionCode }) => {
      const results = [];
      for (const input of links) {
        try {
          results.push({ input, ...(await resolveYouTubeMatch(input, { limit: 5, regionCode })) });
        } catch (error) {
          results.push({ input, error: error instanceof Error ? error.message : String(error) });
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
    safeTool(({ limit }) => youtubeClient.listPlaylists({ limit })),
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
    safeTool(({ name, description, privacyStatus }) => (
      youtubeClient.createPlaylist(name, description, privacyStatus)
    )),
  );

  server.registerTool(
    "youtube_check_playlist_duplicates",
    {
      description: "Find repeated videos in a YouTube playlist without changing it.",
      inputSchema: z.object({ playlist: z.string().min(1) }),
    },
    safeTool(async ({ playlist }) => {
      const loaded = await loadYouTubePlaylist(playlist);
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
    safeTool(async ({ playlist, rules }) => {
      const loaded = await loadYouTubePlaylist(playlist);
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
        playlist: z.string().min(1),
        mode: z.enum(["preview", "apply"]).default("preview"),
      }),
    },
    safeTool(async ({ input, playlist, mode }) => {
      const resolved = await resolveYouTubeMatch(input, { limit: 5 });
      const loaded = await loadYouTubePlaylist(playlist);
      const duplicate = youtubeDuplicate(loaded, resolved.match.id);
      const result = {
        mode,
        source: resolved.source,
        video: resolved.match,
        playlist: youtubePlaylistInfo(loaded, playlist),
        duplicate: Boolean(duplicate),
        existingItem: duplicate,
      };
      if (mode === "preview" || duplicate) {
        return {
          ...result,
          action: duplicate ? "skipped_duplicate" : "would_add",
        };
      }
      await youtubeClient.addVideoToPlaylist(loaded.id, resolved.match.id);
      return { ...result, action: "added" };
    }),
  );

  server.registerTool(
    "youtube_save_track",
    {
      description: "Identify a YouTube song/video, classify it, deduplicate it, and add it to a named or category playlist.",
      inputSchema: z.object({
        input: z.string().min(1),
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
      playlist,
      category,
      mode,
      rules,
      prefix,
      createIfMissing,
      privacyStatus,
      dedupe,
    }) => {
      const resolved = await resolveYouTubeMatch(input, { limit: 5 });
      const selectedCategory = category ?? classifyTrack(resolved.match, rules ?? DEFAULT_RULES);
      const effectivePrefix = prefix || youtubeClient.env.YOUTUBE_PLAYLIST_PREFIX || "";
      const generatedName = boundedName((effectivePrefix ? effectivePrefix + " · " : "") + selectedCategory);
      const targetReference = playlist ?? generatedName;
      const loaded = await loadYouTubePlaylist(targetReference, { allowMissing: true });
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
      if (!target.id) {
        const created = await youtubeClient.createPlaylist(
          targetName,
          "Managed by music-playlist-organizer-mcp. Category: " + selectedCategory,
          privacyStatus,
        );
        target = { id: created.id, details: created, items: [] };
      }
      await youtubeClient.addVideoToPlaylist(target.id, resolved.match.id);
      return {
        ...preview,
        mode,
        playlist: youtubePlaylistInfo(target, targetName),
        playlistAction: loaded.id ? "use_existing" : "created",
        action: "added",
      };
    }),
  );

  return server;
}

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);

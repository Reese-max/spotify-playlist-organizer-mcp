import { McpServer } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { classifyItems, DEFAULT_RULES, findDuplicates, parseLink, parsePlaylistId } from "./core.js";
import { fetchYouTubeMetadata, SpotifyClient } from "./spotify.js";

const client = new SpotifyClient();

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
  return `https://open.spotify.com/playlist/${id}`;
}

function boundedName(name) {
  return name.trim().slice(0, 100);
}

function catalogQuery(value) {
  const compact = value.replace(/[\s-]/g, "").toUpperCase();
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(compact) ? `isrc:${compact}` : value;
}

async function replaceWithChunks(id, uris) {
  await client.replacePlaylistItems(id, uris.slice(0, 100));
  for (let offset = 100; offset < uris.length; offset += 100) {
    await client.addPlaylistItems(id, uris.slice(offset, offset + 100));
  }
}

function createServer() {
  const server = new McpServer({ name: "spotify-playlist-organizer", version: "0.1.0" });

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
      if (artist) query = `${query} ${artist}`.trim();
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
          name: boundedName(`${prefix ? `${prefix} · ` : ""}${category} · ${loaded.details.name}`),
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
          `Derived from ${loaded.details.name} by spotify-playlist-organizer-mcp`,
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

  return server;
}

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);

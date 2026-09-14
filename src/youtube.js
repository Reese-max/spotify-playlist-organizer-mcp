import { parseLink } from "./core.js";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_PAGE_SIZE = 50;

export class YouTubeApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = "YouTubeApiError";
    this.status = status;
    this.body = body;
  }
}

async function readResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function requiredAny(env, names, description) {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  throw new Error(description + " is required for this operation.");
}

function asQuery(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, Array.isArray(value) ? value.join(",") : String(value));
  }
  return query.toString();
}

function normalizeName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function thumbnailUrl(thumbnails) {
  return thumbnails?.medium?.url
    ?? thumbnails?.high?.url
    ?? thumbnails?.default?.url
    ?? null;
}

export function youtubeVideoUrl(id) {
  return "https://www.youtube.com/watch?v=" + encodeURIComponent(id);
}

export function youtubePlaylistUrl(id) {
  return "https://www.youtube.com/playlist?list=" + encodeURIComponent(id);
}

export function youtubeVideoSummary(item, position = null) {
  const snippet = item?.snippet ?? {};
  const contentDetails = item?.contentDetails ?? {};
  const id = contentDetails.videoId
    ?? snippet.resourceId?.videoId
    ?? (typeof item?.id === "string" ? item.id : item?.id?.videoId)
    ?? item?.videoId
    ?? null;
  const channel = snippet.channelTitle ?? item?.channel ?? item?.author ?? null;
  return {
    position,
    id,
    name: snippet.title ?? item?.name ?? item?.title ?? "Unknown video",
    artists: channel ? [channel] : [],
    album: null,
    uri: id ? "youtube:video:" + id : null,
    url: item?.url ?? (id ? youtubeVideoUrl(id) : null),
    platform: "youtube",
    channel,
    description: snippet.description ?? item?.description ?? null,
    publishedAt: snippet.publishedAt ?? item?.publishedAt ?? null,
    duration: contentDetails.duration ?? item?.duration ?? null,
    viewCount: item?.statistics?.viewCount ?? null,
    thumbnail: thumbnailUrl(snippet.thumbnails ?? item?.thumbnails),
  };
}

export function youtubePlaylistSummary(item) {
  const snippet = item?.snippet ?? {};
  const id = typeof item?.id === "string" ? item.id : item?.id?.playlistId ?? null;
  return {
    id,
    name: snippet.title ?? item?.name ?? "Untitled playlist",
    description: snippet.description ?? item?.description ?? null,
    privacyStatus: item?.status?.privacyStatus ?? null,
    itemCount: item?.contentDetails?.itemCount ?? null,
    url: item?.url ?? (id ? youtubePlaylistUrl(id) : null),
    thumbnail: thumbnailUrl(snippet.thumbnails ?? item?.thumbnails),
  };
}

export function parseYouTubeVideoReference(input) {
  const source = parseLink(input);
  if (source.kind === "youtube-video") return source;
  if (source.kind === "youtube-playlist") {
    throw new Error("The supplied YouTube link is a playlist; provide a video link instead.");
  }
  if (/^[A-Za-z0-9_-]{11}$/.test(String(input).trim())) {
    return {
      kind: "youtube-video",
      id: String(input).trim(),
      url: youtubeVideoUrl(String(input).trim()),
    };
  }
  throw new Error("Expected a YouTube video URL, YouTube Music URL, or 11-character video ID.");
}

function looksLikePlaylistId(value) {
  return /^(?:PL|UU|LL|FL|RD|OLAK5uy_)[A-Za-z0-9_-]{5,}$/.test(value)
    || /^[A-Za-z0-9_-]{15,}$/.test(value);
}

export function parseYouTubePlaylistReference(input) {
  const source = parseLink(input);
  if (source.kind === "youtube-playlist") return source;
  if (source.kind === "youtube-video") {
    throw new Error("The supplied YouTube link is a video; provide a playlist reference instead.");
  }
  const value = String(input).trim();
  if (looksLikePlaylistId(value)) {
    return { kind: "youtube-playlist", id: value, url: youtubePlaylistUrl(value) };
  }
  if (!value) throw new Error("A YouTube playlist ID, URL, or name is required.");
  return { kind: "youtube-playlist-name", name: value };
}

export class YouTubeClient {
  constructor(env = process.env, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") {
      throw new Error("This server requires a Node.js runtime with fetch support.");
    }
    this.env = env;
    this.fetch = fetchImpl;
    this.refreshingUserToken = null;
  }

  async refreshUserToken() {
    if (!this.env.YOUTUBE_REFRESH_TOKEN?.trim()) return null;
    if (this.refreshingUserToken) return this.refreshingUserToken;

    this.refreshingUserToken = (async () => {
      const clientId = requiredAny(
        this.env,
        ["GOOGLE_CLIENT_ID", "YOUTUBE_CLIENT_ID"],
        "GOOGLE_CLIENT_ID or YOUTUBE_CLIENT_ID",
      );
      const clientSecret = requiredAny(
        this.env,
        ["GOOGLE_CLIENT_SECRET", "YOUTUBE_CLIENT_SECRET"],
        "GOOGLE_CLIENT_SECRET or YOUTUBE_CLIENT_SECRET",
      );
      const response = await this.fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: this.env.YOUTUBE_REFRESH_TOKEN.trim(),
          grant_type: "refresh_token",
        }),
      });
      const data = await readResponse(response);
      if (!response.ok) {
        throw new YouTubeApiError(response.status, "YouTube OAuth token refresh failed.", data);
      }
      this.env.YOUTUBE_ACCESS_TOKEN = data.access_token;
      return data.access_token;
    })();

    try {
      return await this.refreshingUserToken;
    } finally {
      this.refreshingUserToken = null;
    }
  }

  async getUserToken() {
    if (this.env.YOUTUBE_ACCESS_TOKEN?.trim()) return this.env.YOUTUBE_ACCESS_TOKEN.trim();
    const refreshed = await this.refreshUserToken();
    if (refreshed) return refreshed;
    throw new Error(
      "A YouTube user token is required. Set YOUTUBE_ACCESS_TOKEN or YOUTUBE_REFRESH_TOKEN.",
    );
  }

  async request(path, { method = "GET", query, body, auth = "catalog", retry = true } = {}) {
    const queryParams = { ...(query ?? {}) };
    const hasApiKey = Boolean(this.env.YOUTUBE_API_KEY?.trim());
    const useUserAuth = auth === "user" || (auth === "catalog" && !hasApiKey);
    const headers = {
      Accept: "application/json",
    };

    if (useUserAuth) {
      headers.Authorization = "Bearer " + await this.getUserToken();
    } else {
      queryParams.key = requiredAny(
        this.env,
        ["YOUTUBE_API_KEY"],
        "YOUTUBE_API_KEY or YouTube OAuth credentials",
      );
    }

    if (body !== undefined) headers["Content-Type"] = "application/json";
    const queryString = asQuery(queryParams);
    const url = API_BASE + path + (queryString ? "?" + queryString : "");
    const response = await this.fetch(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await readResponse(response);

    if (response.status === 401 && useUserAuth && retry && this.env.YOUTUBE_REFRESH_TOKEN?.trim()) {
      await this.refreshUserToken();
      return this.request(path, { method, query, body, auth: "user", retry: false });
    }
    if (!response.ok) {
      const detail = typeof data === "object"
        ? data?.error?.message ?? data?.error?.errors?.[0]?.reason
        : null;
      throw new YouTubeApiError(
        response.status,
        "YouTube API request failed" + (detail ? ": " + detail : ""),
        data,
      );
    }
    return data;
  }

  async searchVideos(query, { limit = 10, regionCode, order = "relevance" } = {}) {
    const boundedLimit = Math.min(Math.max(Number(limit) || 10, 1), MAX_PAGE_SIZE);
    const data = await this.request("/search", {
      query: {
        part: "snippet",
        q: query,
        type: "video",
        maxResults: boundedLimit,
        regionCode: regionCode ?? this.env.YOUTUBE_REGION ?? "TW",
        order,
      },
    });
    return {
      query,
      total: data.pageInfo?.totalResults ?? data.items?.length ?? 0,
      videos: (data.items ?? []).map((item, index) => youtubeVideoSummary(item, index + 1)),
    };
  }

  async getVideo(id) {
    const data = await this.request("/videos", {
      query: {
        part: "snippet,contentDetails,statistics,status",
        id,
      },
    });
    const item = data.items?.[0];
    if (!item) throw new Error("YouTube video was not found: " + id);
    return youtubeVideoSummary(item, 1);
  }

  async listPlaylists({ limit = 100 } = {}) {
    const playlists = [];
    const target = Math.max(Number(limit) || 100, 1);
    let pageToken;

    while (playlists.length < target) {
      const page = await this.request("/playlists", {
        auth: "user",
        query: {
          part: "snippet,contentDetails,status",
          mine: true,
          maxResults: Math.min(MAX_PAGE_SIZE, target - playlists.length),
          pageToken,
        },
      });
      const pageItems = page.items ?? [];
      playlists.push(...pageItems.map(youtubePlaylistSummary));
      if (!page.nextPageToken || pageItems.length === 0) break;
      pageToken = page.nextPageToken;
    }

    return { total: playlists.length, playlists: playlists.slice(0, target) };
  }

  async getPlaylist(id) {
    const data = await this.request("/playlists", {
      auth: "user",
      query: {
        part: "snippet,contentDetails,status",
        id,
        maxResults: 1,
      },
    });
    const item = data.items?.[0];
    if (!item) throw new Error("YouTube playlist was not found: " + id);
    return youtubePlaylistSummary(item);
  }

  async getPlaylistItems(id, { limit = 5000 } = {}) {
    const items = [];
    const target = Math.max(Number(limit) || 5000, 1);
    let pageToken;

    while (items.length < target) {
      const page = await this.request("/playlistItems", {
        auth: "user",
        query: {
          part: "snippet,contentDetails,status",
          playlistId: id,
          maxResults: Math.min(MAX_PAGE_SIZE, target - items.length),
          pageToken,
        },
      });
      const pageItems = page.items ?? [];
      items.push(...pageItems.map((item, index) => youtubeVideoSummary(item, items.length + index + 1)));
      if (!page.nextPageToken || pageItems.length === 0) break;
      pageToken = page.nextPageToken;
    }

    return items.slice(0, target);
  }

  async createPlaylist(name, description = "", privacyStatus = "private") {
    const data = await this.request("/playlists", {
      method: "POST",
      auth: "user",
      query: { part: "snippet,status" },
      body: {
        snippet: { title: name, description },
        status: { privacyStatus },
      },
    });
    return youtubePlaylistSummary(data);
  }

  async addVideoToPlaylist(playlistId, videoId) {
    const data = await this.request("/playlistItems", {
      method: "POST",
      auth: "user",
      query: { part: "snippet,contentDetails" },
      body: {
        snippet: {
          playlistId,
          resourceId: { kind: "youtube#video", videoId },
        },
      },
    });
    return youtubeVideoSummary(data);
  }

  async findPlaylistByName(name, { playlists } = {}) {
    const available = playlists ?? (await this.listPlaylists()).playlists;
    return available.find((playlist) => normalizeName(playlist.name) === normalizeName(name)) ?? null;
  }
}

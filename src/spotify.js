import { trackSummary } from "./core.js";

const API_BASE = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

export class SpotifyApiError extends Error {
  constructor(status, message, body = null) {
    super(message);
    this.name = "SpotifyApiError";
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

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required for this operation.`);
  return value;
}

function asQuery(params = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
  }
  return query.toString();
}

export class SpotifyClient {
  constructor(env = process.env, fetchImpl = globalThis.fetch) {
    if (typeof fetchImpl !== "function") throw new Error("This server requires a Node.js runtime with fetch support.");
    this.env = env;
    this.fetch = fetchImpl;
    this.clientToken = null;
    this.refreshingUserToken = null;
  }

  async getClientToken() {
    if (this.env.SPOTIFY_ACCESS_TOKEN?.trim()) return this.env.SPOTIFY_ACCESS_TOKEN.trim();
    if (this.clientToken && this.clientToken.expiresAt > Date.now()) return this.clientToken.value;

    const clientId = required(this.env, "SPOTIFY_CLIENT_ID");
    const clientSecret = required(this.env, "SPOTIFY_CLIENT_SECRET");
    const response = await this.fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    });
    const data = await readResponse(response);
    if (!response.ok) throw new SpotifyApiError(response.status, "Spotify client token request failed.", data);
    this.clientToken = {
      value: data.access_token,
      expiresAt: Date.now() + Math.max(0, Number(data.expires_in ?? 3600) - 60) * 1000,
    };
    return this.clientToken.value;
  }

  async refreshUserToken() {
    if (!this.env.SPOTIFY_REFRESH_TOKEN?.trim()) return null;
    if (this.refreshingUserToken) return this.refreshingUserToken;

    this.refreshingUserToken = (async () => {
      const clientId = required(this.env, "SPOTIFY_CLIENT_ID");
      const clientSecret = required(this.env, "SPOTIFY_CLIENT_SECRET");
      const response = await this.fetch(TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.env.SPOTIFY_REFRESH_TOKEN.trim(),
        }),
      });
      const data = await readResponse(response);
      if (!response.ok) throw new SpotifyApiError(response.status, "Spotify user token refresh failed.", data);
      this.env.SPOTIFY_ACCESS_TOKEN = data.access_token;
      return data.access_token;
    })();

    try {
      return await this.refreshingUserToken;
    } finally {
      this.refreshingUserToken = null;
    }
  }

  async getToken(auth = "catalog") {
    if (auth === "user") {
      if (this.env.SPOTIFY_ACCESS_TOKEN?.trim()) return this.env.SPOTIFY_ACCESS_TOKEN.trim();
      const refreshed = await this.refreshUserToken();
      if (refreshed) return refreshed;
      throw new Error("A Spotify user token is required. Set SPOTIFY_ACCESS_TOKEN or SPOTIFY_REFRESH_TOKEN.");
    }
    return this.getClientToken();
  }

  async request(path, { method = "GET", query, body, auth = "catalog", retry = true } = {}) {
    const queryString = asQuery(query);
    const url = `${API_BASE}${path}${queryString ? `?${queryString}` : ""}`;
    const response = await this.fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${await this.getToken(auth)}`,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const data = await readResponse(response);

    if (response.status === 401 && retry && this.env.SPOTIFY_REFRESH_TOKEN?.trim()) {
      await this.refreshUserToken();
      return this.request(path, { method, query, body, auth: "user", retry: false });
    }
    if (!response.ok) {
      const detail = typeof data === "object" && data?.error?.message ? data.error.message : response.statusText;
      throw new SpotifyApiError(response.status, `Spotify API request failed: ${detail}`, data);
    }
    return data;
  }

  async searchTracks(query, { limit = 10, market } = {}) {
    const data = await this.request("/search", {
      query: { q: query, type: "track", limit, market: market ?? this.env.SPOTIFY_MARKET },
    });
    return {
      query,
      total: data.tracks?.total ?? 0,
      tracks: (data.tracks?.items ?? []).map((track, index) => trackSummary(track, index + 1)),
    };
  }

  async getTrack(id, market) {
    const data = await this.request(`/tracks/${encodeURIComponent(id)}`, {
      query: { market: market ?? this.env.SPOTIFY_MARKET },
    });
    return trackSummary(data, 1);
  }

  async getPlaylist(id) {
    return this.request(`/playlists/${encodeURIComponent(id)}`, { auth: "user" });
  }

  async getPlaylistItems(id) {
    const items = [];
    let offset = 0;
    while (true) {
      const page = await this.request(`/playlists/${encodeURIComponent(id)}/items`, {
        auth: "user",
        query: {
          limit: 50,
          offset,
          market: this.env.SPOTIFY_MARKET,
          additional_types: "track",
        },
      });
      const pageItems = page.items ?? [];
      items.push(...pageItems);
      if (!page.next || pageItems.length === 0) break;
      offset += pageItems.length;
    }
    return items;
  }

  async getCurrentUser() {
    return this.request("/me", { auth: "user" });
  }

  async listCurrentUserPlaylists() {
    const playlists = [];
    let offset = 0;
    while (true) {
      const page = await this.request("/me/playlists", {
        auth: "user",
        query: { limit: 50, offset },
      });
      const pageItems = page.items ?? [];
      playlists.push(...pageItems);
      if (!page.next || pageItems.length === 0) break;
      offset += pageItems.length;
    }
    return playlists;
  }

  async createPlaylist(_userId, name, description, isPublic) {
    return this.request("/me/playlists", {
      method: "POST",
      auth: "user",
      body: {
        name,
        description,
        public: isPublic,
        collaborative: false,
      },
    });
  }

  async replacePlaylistItems(id, uris) {
    return this.request(`/playlists/${encodeURIComponent(id)}/items`, {
      method: "PUT",
      auth: "user",
      body: { uris },
    });
  }

  async addPlaylistItems(id, uris) {
    return this.request(`/playlists/${encodeURIComponent(id)}/items`, {
      method: "POST",
      auth: "user",
      body: { uris },
    });
  }
}

export async function fetchYouTubeMetadata(url, fetchImpl = globalThis.fetch) {
  const endpoint = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const response = await fetchImpl(endpoint, { headers: { Accept: "application/json" } });
  const data = await readResponse(response);
  if (!response.ok) throw new SpotifyApiError(response.status, "YouTube oEmbed lookup failed.", data);
  return {
    title: data.title ?? null,
    author: data.author_name ?? null,
    url,
  };
}

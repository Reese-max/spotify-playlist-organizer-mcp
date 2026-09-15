import { trackSummary } from "./core.js";
import {
  awaitWithDeadline,
  fetchWithDeadline,
  retryDelayMs,
  timeoutFromEnv,
  waitForRetry,
} from "./http.js";

const API_BASE = "https://api.spotify.com/v1";
const TOKEN_URL = "https://accounts.spotify.com/api/token";

export class SpotifyApiError extends Error {
  constructor(status, message, body = null, code = null) {
    super(message);
    this.name = "SpotifyApiError";
    this.status = status;
    this.body = body;
    this.code = code;
  }
}

async function readResponse(response, options = {}) {
  const text = await awaitWithDeadline(response.text(), options);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function required(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(name + " is required for this operation.");
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
    this.timeoutMs = timeoutFromEnv(this.env);
    this.maxReadRetries = Math.min(Math.max(Number(this.env.PROVIDER_MAX_READ_RETRIES) || 1, 0), 2);
  }

  async getClientToken({ signal } = {}) {
    if (this.env.SPOTIFY_ACCESS_TOKEN?.trim()) return this.env.SPOTIFY_ACCESS_TOKEN.trim();
    if (this.clientToken && this.clientToken.expiresAt > Date.now()) return this.clientToken.value;

    const clientId = required(this.env, "SPOTIFY_CLIENT_ID");
    const clientSecret = required(this.env, "SPOTIFY_CLIENT_SECRET");
    const response = await fetchWithDeadline(this.fetch, TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }),
    }, {
      signal,
      timeoutMs: this.timeoutMs,
      operation: "Spotify client token request",
    });
    const data = await readResponse(response, {
      signal,
      timeoutMs: this.timeoutMs,
      operation: "Spotify client token response",
    });
    if (!response.ok) {
      throw new SpotifyApiError(
        response.status,
        "Spotify client token request failed.",
        data,
        response.status === 429 ? "HTTP_429" : response.status >= 500 ? "HTTP_5XX" : null,
      );
    }
    this.clientToken = {
      value: data.access_token,
      expiresAt: Date.now() + Math.max(0, Number(data.expires_in ?? 3600) - 60) * 1000,
    };
    return this.clientToken.value;
  }

  async refreshUserToken({ signal } = {}) {
    if (!this.env.SPOTIFY_REFRESH_TOKEN?.trim()) return null;
    if (this.refreshingUserToken) return this.refreshingUserToken;

    this.refreshingUserToken = (async () => {
      const clientId = required(this.env, "SPOTIFY_CLIENT_ID");
      const clientSecret = required(this.env, "SPOTIFY_CLIENT_SECRET");
      const response = await fetchWithDeadline(this.fetch, TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: "Basic " + Buffer.from(clientId + ":" + clientSecret).toString("base64"),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: this.env.SPOTIFY_REFRESH_TOKEN.trim(),
        }),
      }, {
        signal,
        timeoutMs: this.timeoutMs,
        operation: "Spotify user token request",
      });
      const data = await readResponse(response, {
        signal,
        timeoutMs: this.timeoutMs,
        operation: "Spotify user token response",
      });
      if (!response.ok) {
        throw new SpotifyApiError(
          response.status,
          "Spotify user token refresh failed.",
          data,
          "AUTH_REFRESH_FAILED",
        );
      }
      this.env.SPOTIFY_ACCESS_TOKEN = data.access_token;
      return data.access_token;
    })();

    try {
      return await this.refreshingUserToken;
    } finally {
      this.refreshingUserToken = null;
    }
  }

  async getToken(auth = "catalog", { signal } = {}) {
    if (auth === "user") {
      if (this.env.SPOTIFY_ACCESS_TOKEN?.trim()) return this.env.SPOTIFY_ACCESS_TOKEN.trim();
      const refreshed = await this.refreshUserToken({ signal });
      if (refreshed) return refreshed;
      throw new Error("A Spotify user token is required. Set SPOTIFY_ACCESS_TOKEN or SPOTIFY_REFRESH_TOKEN.");
    }
    return this.getClientToken({ signal });
  }

  async request(path, {
    method = "GET",
    query,
    body,
    auth = "catalog",
    retry = true,
    signal,
  } = {}) {
    const maxAttempts = method === "GET" && retry ? 1 + this.maxReadRetries : 1;
    let attempt = 0;
    let refreshed = false;
    let requestAuth = auth;

    while (true) {
      const queryString = asQuery(query);
      const url = API_BASE + path + (queryString ? "?" + queryString : "");
      const response = await fetchWithDeadline(this.fetch, url, {
        method,
        headers: {
          Authorization: "Bearer " + await this.getToken(requestAuth, { signal }),
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, {
        signal,
        timeoutMs: this.timeoutMs,
        operation: "Spotify API " + method + " " + path,
      });
      const data = await readResponse(response, {
        signal,
        timeoutMs: this.timeoutMs,
        operation: "Spotify API " + method + " " + path + " response",
      });

      if (response.status === 401 && retry && !refreshed && this.env.SPOTIFY_REFRESH_TOKEN?.trim()) {
        refreshed = true;
        await this.refreshUserToken({ signal });
        requestAuth = "user";
        continue;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && method === "GET" && attempt < maxAttempts - 1) {
        await waitForRetry(
          retryDelayMs(response, attempt),
          signal,
          "Spotify API read retry",
        );
        attempt += 1;
        continue;
      }

      if (!response.ok) {
        const detail = typeof data === "object" && data?.error?.message ? data.error.message : response.statusText;
        throw new SpotifyApiError(
          response.status,
          "Spotify API request failed: " + detail,
          data,
          response.status === 429 ? "HTTP_429" : response.status >= 500 ? "HTTP_5XX" : null,
        );
      }
      return data;
    }
  }

  async searchTracks(query, { limit = 10, market, signal } = {}) {
    const data = await this.request("/search", {
      query: { q: query, type: "track", limit, market: market ?? this.env.SPOTIFY_MARKET },
      signal,
    });
    return {
      query,
      total: data.tracks?.total ?? 0,
      tracks: (data.tracks?.items ?? []).map((track, index) => trackSummary(track, index + 1)),
    };
  }

  async getTrack(id, market, { signal } = {}) {
    const data = await this.request("/tracks/" + encodeURIComponent(id), {
      query: { market: market ?? this.env.SPOTIFY_MARKET },
      signal,
    });
    return trackSummary(data, 1);
  }

  async getPlaylist(id, { signal } = {}) {
    return this.request("/playlists/" + encodeURIComponent(id), { auth: "user", signal });
  }

  async getPlaylistItems(id, { signal } = {}) {
    const items = [];
    let offset = 0;
    while (true) {
      const page = await this.request("/playlists/" + encodeURIComponent(id) + "/items", {
        auth: "user",
        query: {
          limit: 50,
          offset,
          market: this.env.SPOTIFY_MARKET,
          additional_types: "track",
        },
        signal,
      });
      const pageItems = page.items ?? [];
      items.push(...pageItems);
      if (!page.next || pageItems.length === 0) break;
      offset += pageItems.length;
    }
    return items;
  }

  async getCurrentUser({ signal } = {}) {
    return this.request("/me", { auth: "user", signal });
  }

  async listCurrentUserPlaylists({ signal } = {}) {
    const playlists = [];
    let offset = 0;
    while (true) {
      const page = await this.request("/me/playlists", {
        auth: "user",
        query: { limit: 50, offset },
        signal,
      });
      const pageItems = page.items ?? [];
      playlists.push(...pageItems);
      if (!page.next || pageItems.length === 0) break;
      offset += pageItems.length;
    }
    return playlists;
  }

  async createPlaylist(_userId, name, description, isPublic, { signal } = {}) {
    return this.request("/me/playlists", {
      method: "POST",
      auth: "user",
      body: {
        name,
        description,
        public: isPublic,
        collaborative: false,
      },
      signal,
    });
  }

  async replacePlaylistItems(id, uris, { signal } = {}) {
    return this.request("/playlists/" + encodeURIComponent(id) + "/items", {
      method: "PUT",
      auth: "user",
      body: { uris },
      signal,
    });
  }

  async addPlaylistItems(id, uris, { signal } = {}) {
    return this.request("/playlists/" + encodeURIComponent(id) + "/items", {
      method: "POST",
      auth: "user",
      body: { uris },
      signal,
    });
  }
}

export async function fetchYouTubeMetadata(
  url,
  fetchImpl = globalThis.fetch,
  { signal, timeoutMs = timeoutFromEnv(), } = {},
) {
  const endpoint = "https://www.youtube.com/oembed?url=" + encodeURIComponent(url) + "&format=json";
  const response = await fetchWithDeadline(fetchImpl, endpoint, {
    headers: { Accept: "application/json" },
  }, {
    signal,
    timeoutMs,
    operation: "YouTube oEmbed request",
  });
  const data = await readResponse(response, {
    signal,
    timeoutMs,
    operation: "YouTube oEmbed response",
  });
  if (!response.ok) {
    throw new SpotifyApiError(
      response.status,
      "YouTube oEmbed lookup failed.",
      data,
      response.status === 429 ? "HTTP_429" : response.status >= 500 ? "HTTP_5XX" : null,
    );
  }
  return {
    title: data.title ?? null,
    author: data.author_name ?? null,
    url,
  };
}

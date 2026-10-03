import { parseLink } from "./core.js";
import {
  CredentialStore,
  credentialsFromTokenResponse,
  REQUIRED_YOUTUBE_SCOPE,
  grantedScopes,
  scopeCovers,
} from "./credentials.js";
import {
  awaitWithDeadline,
  fetchWithDeadline,
  ProviderRequestError,
  retryDelayMs,
  timeoutFromEnv,
  waitForRetry,
} from "./http.js";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_PAGE_SIZE = 50;

export class YouTubeApiError extends Error {
  constructor(status, message, body = null, code = null) {
    super(message);
    this.name = "YouTubeApiError";
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

function hasProviderErrorReason(data, reason) {
  const error = data && typeof data === "object" ? data.error : null;
  return error?.reason === reason
    || (Array.isArray(error?.errors) && error.errors.some((entry) => entry?.reason === reason));
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
    // playlistItems rows carry the row id in item.id — keep it so callers can
    // verify the exact row deleted, not just "some row with this videoId".
    playlistItemId: item?.playlistItemId
      ?? (snippet.playlistId && typeof item?.id === "string" ? item.id : null),
    name: snippet.title ?? item?.name ?? item?.title ?? "Unknown video",
    artists: channel ? [channel] : [],
    album: null,
    uri: id ? "youtube:video:" + id : null,
    url: item?.url ?? (id ? youtubeVideoUrl(id) : null),
    platform: "youtube",
    channel,
    status: item?.status?.privacyStatus ?? (typeof item?.status === "string" ? item.status : null),
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
    this.mintedAccessToken = null;
    this.timeoutMs = timeoutFromEnv(this.env);
    this.maxReadRetries = Math.min(Math.max(Number(this.env.PROVIDER_MAX_READ_RETRIES) || 1, 0), 2);
    this.credentials = new CredentialStore(this.env);
    this.storedCredentials = undefined;
  }

  async loadStoredCredentials() {
    if (this.storedCredentials !== undefined) return this.storedCredentials;
    if (!(await this.credentials.exists())) {
      this.storedCredentials = null;
      return null;
    }
    this.storedCredentials = await this.credentials.load();
    return this.storedCredentials;
  }

  async getRefreshToken() {
    if (this.env.YOUTUBE_REFRESH_TOKEN?.trim()) return this.env.YOUTUBE_REFRESH_TOKEN.trim();
    const stored = await this.loadStoredCredentials();
    return stored?.refreshToken ?? null;
  }

  assertStoredScopeSufficient(stored) {
    if (stored && !scopeCovers(stored.scope)) {
      throw new ProviderRequestError(
        "AUTH_SCOPE_INSUFFICIENT",
        "Stored YouTube credentials do not grant the required scope ("
          + REQUIRED_YOUTUBE_SCOPE
          + "). Re-run npm run youtube:auth and approve YouTube access.",
        { retryable: false },
      );
    }
  }

  assertEnvironmentRefreshScope(stored) {
    const refreshToken = this.env.YOUTUBE_REFRESH_TOKEN?.trim();
    const accessToken = this.env.YOUTUBE_ACCESS_TOKEN?.trim();
    if (
      !stored
      || !refreshToken
      || stored.refreshToken !== refreshToken
      || (accessToken && stored.accessToken !== accessToken)
    ) {
      throw new ProviderRequestError(
        "AUTH_SCOPE_UNKNOWN",
        "The environment-supplied YouTube refresh token is not backed by a matching stored OAuth grant with verified scopes. Run npm run youtube:auth.",
        { retryable: false },
      );
    }
    this.assertStoredScopeSufficient(stored);
    return stored;
  }

  assertEnvironmentAccessScope(stored) {
    const accessToken = this.env.YOUTUBE_ACCESS_TOKEN?.trim();
    if (!stored || !accessToken || stored.accessToken !== accessToken) {
      throw new ProviderRequestError(
        "AUTH_SCOPE_UNKNOWN",
        "The environment-supplied YouTube access token is not backed by a matching stored OAuth grant with verified scopes. Run npm run youtube:auth.",
        { retryable: false },
      );
    }
    this.assertStoredScopeSufficient(stored);
    return stored;
  }

  async refreshUserToken({ signal } = {}) {
    if (this.refreshingUserToken) return this.refreshingUserToken;

    // Assigned synchronously so a concurrent call observes the in-flight
    // exchange before either side reaches an await boundary.
    this.refreshingUserToken = (async () => {
      const refreshToken = await this.getRefreshToken();
      if (!refreshToken) return null;
      const previous = await this.loadStoredCredentials();
      if (this.env.YOUTUBE_REFRESH_TOKEN?.trim()) {
        this.assertEnvironmentRefreshScope(previous);
      } else if (previous) {
        this.assertStoredScopeSufficient(previous);
      }
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
      const response = await fetchWithDeadline(this.fetch, TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        }),
      }, {
        signal,
        timeoutMs: this.timeoutMs,
        operation: "YouTube OAuth token request",
      });
      const data = await readResponse(response, {
        signal,
        timeoutMs: this.timeoutMs,
        operation: "YouTube OAuth token response",
      });
      if (!response.ok) {
        throw new YouTubeApiError(
          response.status,
          "YouTube OAuth token refresh failed.",
          data,
          "AUTH_REFRESH_FAILED",
        );
      }
      const credentials = credentialsFromTokenResponse(data, previous ?? { refreshToken });
      // Persist only when the token we used came from this store record —
      // an env-supplied refresh token must never overwrite a different
      // account's stored credential or seed a store that does not exist.
      if (
        this.credentials.passphraseConfigured
        && credentials.refreshToken
        && previous?.refreshToken === refreshToken
      ) {
        await this.credentials.save(credentials);
        this.storedCredentials = credentials;
      }
      this.mintedAccessToken = { token: credentials.accessToken, expiresAt: credentials.expiresAt };
      return credentials.accessToken;
    })();

    try {
      return await this.refreshingUserToken;
    } finally {
      this.refreshingUserToken = null;
    }
  }

  async getUserToken({ signal } = {}) {
    // A token minted by a refresh supersedes a stale env access token; the
    // operator-provided env value itself is never overwritten, so
    // credentialStatus keeps reporting the true credential source.
    const minted = this.mintedAccessToken;
    if (minted && (!minted.expiresAt || minted.expiresAt > Date.now())) {
      return minted.token;
    }
    const environmentAccessToken = this.env.YOUTUBE_ACCESS_TOKEN?.trim();
    let environmentGrant = null;
    if (this.env.YOUTUBE_REFRESH_TOKEN?.trim()) {
      environmentGrant = this.assertEnvironmentRefreshScope(await this.loadStoredCredentials());
    } else if (environmentAccessToken) {
      environmentGrant = this.assertEnvironmentAccessScope(await this.loadStoredCredentials());
    }
    if (
      environmentAccessToken
      && (!environmentGrant?.expiresAt || environmentGrant.expiresAt > Date.now())
    ) {
      return environmentAccessToken;
    }
    const stored = await this.loadStoredCredentials();
    if (stored?.accessToken && (!stored.expiresAt || stored.expiresAt > Date.now()) && scopeCovers(stored.scope)) {
      return stored.accessToken;
    }
    const refreshed = await this.refreshUserToken({ signal });
    if (refreshed) return refreshed;
    throw new Error(
      "A YouTube user token is required. Configure the encrypted credential store or set the explicit environment fallback.",
    );
  }

  async request(path, {
    method = "GET",
    query,
    body,
    auth = "catalog",
    retry = true,
    signal,
  } = {}) {
    const queryParams = { ...(query ?? {}) };
    const hasApiKey = Boolean(this.env.YOUTUBE_API_KEY?.trim());
    const useUserAuth = auth === "user" || (auth === "catalog" && !hasApiKey);
    const maxAttempts = method === "GET" && retry ? 1 + this.maxReadRetries : 1;
    let attempt = 0;
    let refreshed = false;

    while (true) {
      const headers = { Accept: "application/json" };
      if (useUserAuth) {
        headers.Authorization = "Bearer " + await this.getUserToken({ signal });
      } else {
        queryParams.key = requiredAny(
          this.env,
          ["YOUTUBE_API_KEY"],
          "YOUTUBE_API_KEY or YouTube OAuth credentials",
        );
      }

      if (body !== undefined) headers["Content-Type"] = "application/json";
      const queryString = asQuery(queryParams);
      const apiBase = this.env.YOUTUBE_API_BASE?.trim() || API_BASE;
      const url = apiBase + path + (queryString ? "?" + queryString : "");
      const response = await fetchWithDeadline(this.fetch, url, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }, {
        signal,
        timeoutMs: this.timeoutMs,
        operation: "YouTube API " + method + " " + path,
      });
      const data = await readResponse(response, {
        signal,
        timeoutMs: this.timeoutMs,
        operation: "YouTube API " + method + " " + path + " response",
      });

      if (
        response.status === 401
        && useUserAuth
        && retry
        && !refreshed
        && await this.getRefreshToken()
      ) {
        refreshed = true;
        await this.refreshUserToken({ signal });
        continue;
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && method === "GET" && attempt < maxAttempts - 1) {
        await waitForRetry(
          retryDelayMs(response, attempt),
          signal,
          "YouTube API read retry",
        );
        attempt += 1;
        continue;
      }

      if (!response.ok) {
        const quotaExceeded = response.status === 403
          && hasProviderErrorReason(data, "quotaExceeded");
        if (quotaExceeded) {
          // Do not echo provider-supplied text or a URL containing the API key.
          const error = new YouTubeApiError(
            response.status,
            "YouTube API quota exceeded for " + method + " " + path + ".",
            data,
            "YOUTUBE_QUOTA_EXCEEDED",
          );
          error.operation = method + " " + path;
          error.nextStep = method === "GET" && path === "/search"
            ? "Call youtube_identify_track with input set to an exact YouTube video URL or 11-character video ID; it uses video lookup without another search request, but that lookup may fail independently."
            : "Retry this YouTube operation after its quota is available; no fallback is guaranteed.";
          throw error;
        }
        const detail = typeof data === "object"
          ? data?.error?.message ?? data?.error?.errors?.[0]?.reason
          : null;
        throw new YouTubeApiError(
          response.status,
          "YouTube API request failed" + (detail ? ": " + detail : ""),
          data,
          response.status === 429 ? "HTTP_429" : response.status >= 500 ? "HTTP_5XX" : null,
        );
      }
      return data;
    }
  }

  async searchVideos(query, { limit = 10, regionCode, order = "relevance", signal } = {}) {
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
      signal,
    });
    return {
      query,
      total: data.pageInfo?.totalResults ?? data.items?.length ?? 0,
      videos: (data.items ?? []).map((item, index) => youtubeVideoSummary(item, index + 1)),
    };
  }

  async getVideo(id, { signal } = {}) {
    const data = await this.request("/videos", {
      query: {
        part: "snippet,contentDetails,statistics,status",
        id,
      },
      signal,
    });
    const item = data.items?.[0];
    if (!item) {
      // The API answers deleted/unknown videos with 200 + empty items; tag
      // it so read-backs can distinguish confirmed-absence from unreadable.
      const error = new Error("YouTube video was not found: " + id);
      error.code = "NOT_FOUND";
      throw error;
    }
    return youtubeVideoSummary(item, 1);
  }

  async listPlaylists({ limit = 100, signal } = {}) {
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
        signal,
      });
      const pageItems = page.items ?? [];
      playlists.push(...pageItems.map(youtubePlaylistSummary));
      if (!page.nextPageToken || pageItems.length === 0) break;
      pageToken = page.nextPageToken;
    }

    return { total: playlists.length, playlists: playlists.slice(0, target) };
  }

  async getPlaylist(id, { signal } = {}) {
    const data = await this.request("/playlists", {
      auth: "user",
      query: {
        part: "snippet,contentDetails,status",
        id,
        maxResults: 1,
      },
      signal,
    });
    const item = data.items?.[0];
    if (!item) {
      const error = new Error("YouTube playlist was not found: " + id);
      error.code = "NOT_FOUND";
      throw error;
    }
    return youtubePlaylistSummary(item);
  }

  async getPlaylistItems(id, { limit = 5000, signal } = {}) {
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
        signal,
      });
      const pageItems = page.items ?? [];
      items.push(...pageItems.map((item, index) => youtubeVideoSummary(item, items.length + index + 1)));
      if (!page.nextPageToken || pageItems.length === 0) break;
      pageToken = page.nextPageToken;
    }

    return items.slice(0, target);
  }

  async createPlaylist(name, description = "", privacyStatus = "private", { signal } = {}) {
    const data = await this.request("/playlists", {
      method: "POST",
      auth: "user",
      query: { part: "snippet,status" },
      body: {
        snippet: { title: name, description },
        status: { privacyStatus },
      },
      signal,
    });
    return youtubePlaylistSummary(data);
  }

  async addVideoToPlaylist(playlistId, videoId, { signal } = {}) {
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
      signal,
    });
    return youtubeVideoSummary(data);
  }

  async removeVideoFromPlaylist(playlistId, videoId, { signal } = {}) {
    // playlistItems.delete needs the playlist-item ID, which differs from the
    // video ID — page the playlist until the matching item is found.
    let pageToken;
    let itemId = null;
    while (itemId === null) {
      const page = await this.request("/playlistItems", {
        auth: "user",
        query: {
          part: "snippet,contentDetails",
          playlistId,
          maxResults: MAX_PAGE_SIZE,
          pageToken,
        },
        signal,
      });
      const pageItems = page.items ?? [];
      const found = pageItems.find(
        (item) => (item.contentDetails?.videoId ?? item.snippet?.resourceId?.videoId) === videoId,
      );
      if (found) {
        itemId = found.id;
      } else if (page.nextPageToken && pageItems.length) {
        pageToken = page.nextPageToken;
      } else {
        break;
      }
    }
    if (itemId === null) {
      return { removed: false, playlistId, videoId, reason: "not_in_playlist" };
    }
    await this.request("/playlistItems", {
      method: "DELETE",
      auth: "user",
      query: { id: itemId },
      signal,
    });
    return { removed: true, playlistId, playlistItemId: itemId, videoId };
  }

  async renamePlaylist(playlistId, name, { signal } = {}) {
    // playlists.update replaces the whole snippet part, so the writable
    // fields we are not changing must be sent back or they are cleared.
    const current = await this.request("/playlists", {
      auth: "user",
      query: { part: "snippet,status", id: playlistId, maxResults: 1 },
      signal,
    });
    const item = current.items?.[0];
    if (!item) {
      const error = new Error("YouTube playlist was not found: " + playlistId);
      error.code = "NOT_FOUND";
      throw error;
    }
    const prior = item.snippet ?? {};
    const snippet = { title: name };
    for (const field of ["description", "tags", "defaultLanguage"]) {
      if (prior[field] !== undefined) snippet[field] = prior[field];
    }
    const data = await this.request("/playlists", {
      method: "PUT",
      auth: "user",
      query: { part: "snippet,status" },
      body: {
        id: playlistId,
        snippet,
        ...(item.status ? { status: { privacyStatus: item.status.privacyStatus } } : {}),
      },
      signal,
    });
    return youtubePlaylistSummary(data);
  }

  async deletePlaylist(playlistId, { signal } = {}) {
    await this.request("/playlists", {
      method: "DELETE",
      auth: "user",
      query: { id: playlistId },
      signal,
    });
    return { deleted: true, playlistId };
  }

  async credentialStatus() {
    const hasEnvironmentCredential = Boolean(
      this.env.YOUTUBE_ACCESS_TOKEN?.trim() || this.env.YOUTUBE_REFRESH_TOKEN?.trim(),
    );
    const storedStatus = await this.credentials.status();
    if (storedStatus.status === "REVOKED" || storedStatus.status === "UNKNOWN") return storedStatus;
    if (hasEnvironmentCredential) {
      if (!this.env.YOUTUBE_REFRESH_TOKEN?.trim()) {
        try {
          const stored = this.assertEnvironmentAccessScope(await this.loadStoredCredentials());
          const expired = stored.expiresAt !== null && stored.expiresAt <= Date.now();
          return {
            status: expired ? "EXPIRED" : "READY",
            source: "environment",
            filePath: this.credentials.filePath,
            refreshable: false,
            scope: stored.scope || null,
            grantedScopes: grantedScopes(stored.scope),
            requiredScope: REQUIRED_YOUTUBE_SCOPE,
            scopeSufficient: true,
            expiresAt: stored.expiresAt,
            warning: "INSECURE_ENVIRONMENT_FALLBACK",
          };
        } catch (error) {
          return {
            status: "UNKNOWN",
            source: "environment",
            filePath: this.credentials.filePath,
            refreshable: false,
            requiredScope: REQUIRED_YOUTUBE_SCOPE,
            scopeSufficient: false,
            reason: error.code ?? "AUTH_SCOPE_UNKNOWN",
            warning: "INSECURE_ENVIRONMENT_FALLBACK",
          };
        }
      }
      try {
        const stored = this.assertEnvironmentRefreshScope(await this.loadStoredCredentials());
        const hasRefresh = Boolean(this.env.YOUTUBE_REFRESH_TOKEN?.trim() || stored.refreshToken);
        const hasAccess = Boolean(this.env.YOUTUBE_ACCESS_TOKEN?.trim() || stored.accessToken);
        const expired = stored.expiresAt !== null && stored.expiresAt <= Date.now();
        return {
          status: hasRefresh || (hasAccess && !expired) ? "READY" : hasAccess ? "EXPIRED" : "UNKNOWN",
          source: "environment",
          filePath: this.credentials.filePath,
          refreshable: hasRefresh,
          scope: stored.scope || null,
          grantedScopes: grantedScopes(stored.scope),
          requiredScope: REQUIRED_YOUTUBE_SCOPE,
          scopeSufficient: true,
          warning: "INSECURE_ENVIRONMENT_FALLBACK",
        };
      } catch (error) {
        return {
          status: "UNKNOWN",
          source: "environment",
          filePath: this.credentials.filePath,
          refreshable: Boolean(this.env.YOUTUBE_REFRESH_TOKEN?.trim()),
          requiredScope: REQUIRED_YOUTUBE_SCOPE,
          scopeSufficient: false,
          reason: error.code ?? "AUTH_SCOPE_UNKNOWN",
          warning: "INSECURE_ENVIRONMENT_FALLBACK",
        };
      }
    }
    return storedStatus;
  }

  async revokeUserCredentials({ signal } = {}) {
    const hasEnvironmentCredential = Boolean(
      this.env.YOUTUBE_ACCESS_TOKEN?.trim() || this.env.YOUTUBE_REFRESH_TOKEN?.trim(),
    );
    const hasFileCredential = await this.credentials.exists();
    let stored = null;
    let storeUnreadable = false;
    if (this.credentials.passphraseConfigured) {
      this.storedCredentials = undefined;
      try {
        stored = await this.loadStoredCredentials();
      } catch {
        // An undecryptable record (wrong/missing passphrase) is still deleted
        // below — revoke means the local credential goes away either way.
        storeUnreadable = true;
      }
    }
    const refreshToken = this.env.YOUTUBE_REFRESH_TOKEN?.trim() || stored?.refreshToken || null;
    const accessToken = this.env.YOUTUBE_ACCESS_TOKEN?.trim()
      || stored?.accessToken
      || this.mintedAccessToken?.token
      || null;
    const token = refreshToken || accessToken;
    if (!token) {
      // Without a readable token we cannot prove a remote revoke — but the
      // local record can still be deleted. Report the remote state honestly
      // rather than claiming a revoke that never happened.
      if (hasFileCredential) {
        await this.credentials.recordStatus("UNKNOWN", storeUnreadable
          ? "CREDENTIAL_DECRYPT_FAILED"
          : "CREDENTIAL_PASSPHRASE_REQUIRED");
      }
      const deleted = hasFileCredential ? await this.credentials.remove() : false;
      this.storedCredentials = null;
      this.mintedAccessToken = null;
      return {
        status: hasFileCredential ? "UNKNOWN" : "MISSING",
        source: hasFileCredential ? "encrypted_file" : "none",
        localCredentialsDeleted: deleted,
        ...(hasFileCredential ? {
          reason: storeUnreadable ? "CREDENTIAL_DECRYPT_FAILED" : "CREDENTIAL_PASSPHRASE_REQUIRED",
          nextStep: "The local credential record was deleted, but the remote grant could not be revoked without a readable token; revoke it from the Google account permissions page if needed.",
        } : {}),
      };
    }

    const response = await fetchWithDeadline(this.fetch, "https://oauth2.googleapis.com/revoke", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
    }, {
      signal,
      timeoutMs: this.timeoutMs,
      operation: "YouTube OAuth revoke request",
    });
    const data = await readResponse(response, {
      signal,
      timeoutMs: this.timeoutMs,
      operation: "YouTube OAuth revoke response",
    });
    if (!response.ok && response.status !== 400) {
      throw new YouTubeApiError(response.status, "YouTube OAuth revoke failed.", data, "AUTH_REVOKE_FAILED");
    }

    await this.credentials.recordStatus("REVOKED");
    const deleted = await this.credentials.remove();
    this.storedCredentials = null;
    this.mintedAccessToken = null;
    delete this.env.YOUTUBE_ACCESS_TOKEN;
    delete this.env.YOUTUBE_REFRESH_TOKEN;
    return {
      status: "REVOKED",
      source: hasEnvironmentCredential && hasFileCredential
        ? "environment_and_encrypted_file"
        : hasEnvironmentCredential
          ? "environment"
          : "encrypted_file",
      localCredentialsDeleted: deleted,
      environmentCredentialsCleared: hasEnvironmentCredential,
    };
  }

  async findPlaylistByName(name, { playlists } = {}) {
    const available = playlists ?? (await this.listPlaylists()).playlists;
    return available.find((playlist) => normalizeName(playlist.name) === normalizeName(name)) ?? null;
  }
}

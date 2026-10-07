import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { ProviderRequestError } from "../src/http.js";
import { fetchYouTubeMetadata, SpotifyClient } from "../src/spotify.js";
import { YouTubeClient } from "../src/youtube.js";

const SECRET_TOKEN = "timeout-test-access-token";
const SECRET_REFRESH = "timeout-test-refresh-token";
const SECRET_CLIENT = "timeout-test-client-secret";

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: () => "0" },
    async text() {
      return JSON.stringify(data);
    },
  };
}

const hangForever = () => new Promise(() => {});

function youtubeEnv(overrides = {}) {
  return {
    YOUTUBE_API_KEY: "timeout-test-key",
    PROVIDER_TIMEOUT_MS: "25",
    ...overrides,
  };
}

function spotifyEnv(overrides = {}) {
  return {
    SPOTIFY_ACCESS_TOKEN: SECRET_TOKEN,
    SPOTIFY_CLIENT_ID: "timeout-test-client-id",
    SPOTIFY_CLIENT_SECRET: SECRET_CLIENT,
    PROVIDER_TIMEOUT_MS: "25",
    ...overrides,
  };
}

function scanForSecrets(label, value) {
  const text = JSON.stringify(value, (_, entry) => (entry instanceof Error ? {
    message: entry.message,
    code: entry.code,
    status: entry.status,
    name: entry.name,
  } : entry));
  for (const secret of [SECRET_TOKEN, SECRET_REFRESH, SECRET_CLIENT]) {
    assert.equal(text.includes(secret), false, label + " leaked a secret");
  }
}

test("PROVIDER_MAX_READ_RETRIES=0 disables read retries with a single attempt", async () => {
  let calls = 0;
  const client = new YouTubeClient(youtubeEnv({ PROVIDER_MAX_READ_RETRIES: "0" }), async () => {
    calls += 1;
    return jsonResponse({ error: { message: "still broken" } }, 500);
  });
  await assert.rejects(
    client.searchVideos("focus"),
    (error) => error.status === 503 || error.status === 500,
  );
  assert.equal(calls, 1);
});

test("concurrent Spotify client-credentials token fetches share one request", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse({ access_token: "shared-token", expires_in: 3600 });
  };
  const client = new SpotifyClient(
    {
      SPOTIFY_CLIENT_ID: "timeout-test-client-id",
      SPOTIFY_CLIENT_SECRET: SECRET_CLIENT,
      PROVIDER_TIMEOUT_MS: "1000",
    },
    fetchImpl,
  );
  const [first, second] = await Promise.all([client.getClientToken(), client.getClientToken()]);
  assert.equal(first, "shared-token");
  assert.equal(second, "shared-token");
  assert.equal(calls, 1);
});

test("never-resolving YouTube reads, refresh, and revoke paths time out within the bound", async () => {
  const started = Date.now();
  const searchClient = new YouTubeClient(youtubeEnv(), hangForever);
  await assert.rejects(
    searchClient.searchVideos("focus"),
    (error) => error instanceof ProviderRequestError && error.code === "TIMEOUT",
  );
  const listClient = new YouTubeClient(
    youtubeEnv({ YOUTUBE_ACCESS_TOKEN: SECRET_TOKEN }),
    hangForever,
  );
  await assert.rejects(
    listClient.listPlaylists({ limit: 5 }),
    (error) => error instanceof ProviderRequestError && error.code === "TIMEOUT",
  );
  const refreshClient = new YouTubeClient(
    youtubeEnv({
      YOUTUBE_API_KEY: undefined,
      GOOGLE_CLIENT_ID: "timeout-test-client-id",
      GOOGLE_CLIENT_SECRET: SECRET_CLIENT,
      YOUTUBE_REFRESH_TOKEN: SECRET_REFRESH,
    }),
    hangForever,
  );
  await assert.rejects(
    refreshClient.refreshUserToken(),
    (error) => error instanceof ProviderRequestError && error.code === "TIMEOUT",
  );
  assert.ok(Date.now() - started < 2000);
});

test("caller abort is distinct from provider timeout and never calls a pre-aborted fetch", async () => {
  let calls = 0;
  const client = new YouTubeClient(youtubeEnv(), async () => {
    calls += 1;
    return jsonResponse({ items: [] });
  });
  const preAborted = new AbortController();
  preAborted.abort();
  await assert.rejects(
    client.searchVideos("focus", { signal: preAborted.signal }),
    (error) => error instanceof ProviderRequestError && error.code === "CALLER_CANCELLED",
  );
  assert.equal(calls, 0);

  const midFlight = new AbortController();
  const pending = client.searchVideos("focus", { signal: midFlight.signal });
  midFlight.abort();
  await assert.rejects(
    pending,
    (error) => error instanceof ProviderRequestError && error.code === "CALLER_CANCELLED",
  );
});

test("a delayed provider success before the deadline resolves normally", async () => {
  const client = new YouTubeClient(youtubeEnv({ PROVIDER_TIMEOUT_MS: "1000" }), async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    return jsonResponse({ pageInfo: { totalResults: 1 }, items: [] });
  });
  const result = await client.searchVideos("focus");
  assert.equal(result.total, 1);
});

test("a delayed provider success after the deadline is a typed timeout", async () => {
  const client = new YouTubeClient(youtubeEnv(), async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    return jsonResponse({ pageInfo: { totalResults: 1 }, items: [] });
  });
  const started = Date.now();
  await assert.rejects(
    client.searchVideos("focus"),
    (error) => error instanceof ProviderRequestError && error.code === "TIMEOUT",
  );
  assert.ok(Date.now() - started < 2000);
});

test("Spotify 429/5xx reads retry finitely and then surface typed errors", async () => {
  let calls = 0;
  const recovering = new SpotifyClient(spotifyEnv(), async () => {
    calls += 1;
    if (calls === 1) return { ...jsonResponse({ error: { message: "slow down" } }, 429) };
    return jsonResponse({ tracks: { total: 0, items: [] } });
  });
  await recovering.searchTracks("focus");
  assert.equal(calls, 2);

  let failingCalls = 0;
  const failing = new SpotifyClient(spotifyEnv(), async () => {
    failingCalls += 1;
    return jsonResponse({ error: { message: "broken" } }, 500);
  });
  await assert.rejects(
    failing.searchTracks("focus"),
    (error) => error.code === "HTTP_5XX" && error.status === 500,
  );
  assert.equal(failingCalls, 2);
});

test("a stalled Spotify token refresh is bounded and concurrent refreshers share it", async () => {
  const stalled = new SpotifyClient(
    {
      SPOTIFY_CLIENT_ID: "timeout-test-client-id",
      SPOTIFY_CLIENT_SECRET: SECRET_CLIENT,
      SPOTIFY_REFRESH_TOKEN: SECRET_REFRESH,
      PROVIDER_TIMEOUT_MS: "25",
    },
    hangForever,
  );
  const started = Date.now();
  await assert.rejects(
    stalled.refreshUserToken(),
    (error) => error instanceof ProviderRequestError && error.code === "TIMEOUT",
  );
  assert.ok(Date.now() - started < 2000);

  let calls = 0;
  const shared = new SpotifyClient(
    {
      SPOTIFY_CLIENT_ID: "timeout-test-client-id",
      SPOTIFY_CLIENT_SECRET: SECRET_CLIENT,
      SPOTIFY_REFRESH_TOKEN: SECRET_REFRESH,
      PROVIDER_TIMEOUT_MS: "1000",
    },
    async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return jsonResponse({ access_token: "shared-user-token", expires_in: 3600 });
    },
  );
  const [first, second] = await Promise.all([shared.refreshUserToken(), shared.refreshUserToken()]);
  assert.equal(first, "shared-user-token");
  assert.equal(second, "shared-user-token");
  assert.equal(calls, 1);
});

test("YouTube oEmbed lookup is bounded by the same deadline", async () => {
  const started = Date.now();
  await assert.rejects(
    fetchYouTubeMetadata("https://www.youtube.com/watch?v=dQw4w9WgXcQ", hangForever, { timeoutMs: 25 }),
    (error) => error instanceof ProviderRequestError && error.code === "TIMEOUT",
  );
  assert.ok(Date.now() - started < 2000);
});

test("an ambiguous write timeout issues exactly one mutation", async () => {
  let calls = 0;
  const client = new YouTubeClient(
    youtubeEnv({ YOUTUBE_ACCESS_TOKEN: SECRET_TOKEN }),
    async () => {
      calls += 1;
      return hangForever();
    },
  );
  await assert.rejects(
    client.addVideoToPlaylist("PL1234567890123456", "dQw4w9WgXcQ"),
    (error) => error instanceof ProviderRequestError && error.code === "TIMEOUT",
  );
  assert.equal(calls, 1);
});

test("timeout, cancel, and provider errors carry no secrets", async () => {
  const client = new YouTubeClient(
    youtubeEnv({ YOUTUBE_ACCESS_TOKEN: SECRET_TOKEN }),
    hangForever,
  );
  const timeout = await client.searchVideos("focus").then(
    () => assert.fail("expected a timeout"),
    (error) => error,
  );
  scanForSecrets("timeout", timeout);

  const controller = new AbortController();
  const pending = client.searchVideos("focus", { signal: controller.signal });
  controller.abort();
  const cancelled = await pending.then(
    () => assert.fail("expected cancellation"),
    (error) => error,
  );
  scanForSecrets("cancellation", cancelled);

  const failing = new YouTubeClient(
    youtubeEnv({ YOUTUBE_ACCESS_TOKEN: SECRET_TOKEN }),
    async () => jsonResponse({ error: { message: "contains " + SECRET_TOKEN } }, 400),
  );
  const providerError = await failing.searchVideos("focus").then(
    () => assert.fail("expected a provider error"),
    (error) => error,
  );
  scanForSecrets("provider error", {
    message: providerError.message,
    code: providerError.code,
    status: providerError.status,
  });
});

test("timers and abort listeners are released after timeout and cancellation", async () => {
  const timeoutSignal = new AbortController().signal;
  const timeoutClient = new YouTubeClient(youtubeEnv(), hangForever);
  await assert.rejects(timeoutClient.searchVideos("focus", { signal: timeoutSignal }));
  assert.equal(getEventListeners(timeoutSignal, "abort").length, 0);

  const cancelController = new AbortController();
  const cancelClient = new YouTubeClient(youtubeEnv(), hangForever);
  const pending = cancelClient.searchVideos("focus", { signal: cancelController.signal });
  cancelController.abort();
  await assert.rejects(pending);
  assert.equal(getEventListeners(cancelController.signal, "abort").length, 0);
});

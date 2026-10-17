import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
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

const tokenClients = [
  ["Spotify client token", (fetchImpl) => new SpotifyClient(spotifyEnv({ SPOTIFY_ACCESS_TOKEN: undefined, PROVIDER_TIMEOUT_MS: "1000" }), fetchImpl), "getClientToken"],
  ["Spotify refresh", (fetchImpl) => new SpotifyClient(spotifyEnv({ SPOTIFY_REFRESH_TOKEN: SECRET_REFRESH, PROVIDER_TIMEOUT_MS: "1000" }), fetchImpl), "refreshUserToken"],
  ["YouTube refresh", (fetchImpl) => new YouTubeClient(youtubeEnv({
    GOOGLE_CLIENT_ID: "test-client",
    GOOGLE_CLIENT_SECRET: SECRET_CLIENT,
    YOUTUBE_REFRESH_TOKEN: SECRET_REFRESH,
    YOUTUBE_CREDENTIAL_FILE: join(tmpdir(), randomUUID() + ".json"),
    PROVIDER_TIMEOUT_MS: "1000",
  }), fetchImpl), "refreshUserToken"],
];

for (const [name, makeClient, method] of tokenClients) {
  test(name + " preserves token endpoint error code and HTTP status", async () => {
    const status = method === "getClientToken" ? 429 : 401;
    const code = method === "getClientToken" ? "HTTP_429" : "AUTH_REFRESH_FAILED";
    const client = makeClient(async () => jsonResponse({ error: "access_denied" }, status));
    await assert.rejects(client[method](), (error) => {
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.equal(error.body.error, "access_denied");
      return true;
    });
  });

  for (const cancelledIndex of [0, 1]) {
    test(name + " isolates cancellation of waiter " + cancelledIndex, async () => {
      const reply = Promise.withResolvers();
      let calls = 0;
      const client = makeClient(async (_url, { signal }) => {
        calls += 1;
        assert.equal(signal.aborted, false);
        return reply.promise;
      });
      const controllers = [new AbortController(), new AbortController()];
      const pending = controllers.map((controller) => client[method]({ signal: controller.signal })
        .then((token) => token, (error) => error.code));
      await nextTurn();
      controllers[cancelledIndex].abort();
      reply.resolve(jsonResponse({ access_token: "shared-token", expires_in: 3600 }));
      const results = await Promise.all(pending);
      assert.equal(results[cancelledIndex], "CALLER_CANCELLED");
      assert.equal(results[1 - cancelledIndex], "shared-token");
      assert.equal(calls, 1);
      for (const controller of controllers) assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });
  }

  test(name + " aborts the transport after the last waiter cancels and can recover", async () => {
    let transportSignal;
    let calls = 0;
    const client = makeClient(async (_url, { signal }) => {
      transportSignal = signal;
      calls += 1;
      return calls === 1 ? hangForever() : jsonResponse({ access_token: "recovered-token" });
    });
    const controller = new AbortController();
    const pending = client[method]({ signal: controller.signal });
    const rejected = assert.rejects(pending, (error) => error.code === "CALLER_CANCELLED");
    await nextTurn();
    controller.abort();
    await rejected;
    assert.equal(transportSignal.aborted, true);
    assert.equal(await client[method](), "recovered-token");
    assert.equal(calls, 2);
  });
}

test("body timeout and cancellation abort the real provider transport", async (t) => {
  const operations = [
    ["YouTube read", (fetchImpl, signal) => new YouTubeClient(youtubeEnv({ PROVIDER_TIMEOUT_MS: "300" }), fetchImpl).searchVideos("focus", { signal })],
    ["Spotify read", (fetchImpl, signal) => new SpotifyClient(spotifyEnv({ PROVIDER_TIMEOUT_MS: "300" }), fetchImpl).searchTracks("focus", { signal })],
    ...tokenClients.map(([name, makeClient, method]) => [name, (fetchImpl, signal) => makeClient(fetchImpl)[method]({ signal })]),
    ["YouTube revoke", (fetchImpl, signal) => new YouTubeClient(youtubeEnv({ YOUTUBE_ACCESS_TOKEN: SECRET_TOKEN, PROVIDER_TIMEOUT_MS: "300" }), fetchImpl).revokeUserCredentials({ signal })],
    ["YouTube oEmbed", (fetchImpl, signal) => fetchYouTubeMetadata("https://www.youtube.com/watch?v=dQw4w9WgXcQ", fetchImpl, { signal, timeoutMs: 300 })],
  ];
  for (const [name, run] of operations) {
    for (const cancel of [false, true]) {
      await t.test(name + (cancel ? " cancellation" : " timeout"), { timeout: 5000 }, async (t) => {
        const closed = Promise.withResolvers();
        const reading = Promise.withResolvers();
        const server = createServer((_req, res) => {
          res.on("close", closed.resolve);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.write("{");
        });
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        t.after(async () => {
          server.closeAllConnections();
          await new Promise((resolve) => server.close(resolve));
        });
        let transportSignal;
        const fetchImpl = async (_url, options) => {
          transportSignal = options.signal;
          const response = await fetch("http://127.0.0.1:" + server.address().port, options);
          return {
            ok: response.ok,
            status: response.status,
            headers: response.headers,
            text() {
              const body = response.text();
              reading.resolve();
              return body;
            },
          };
        };
        const controller = new AbortController();
        const pending = run(fetchImpl, controller.signal);
        const rejected = assert.rejects(pending, (error) => error.code === (cancel ? "CALLER_CANCELLED" : "TIMEOUT"));
        await reading.promise;
        if (cancel) controller.abort();
        await rejected;
        assert.equal(transportSignal.aborted, true, "body completion must abort the active fetch");
        await closed.promise;
        assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      });
    }
  }
});

test("provider Retry-After beyond the retry budget never causes an early retry", async (t) => {
  for (const [name, makeClient] of [
    ["YouTube", (fetchImpl) => new YouTubeClient(youtubeEnv(), fetchImpl)],
    ["Spotify", (fetchImpl) => new SpotifyClient(spotifyEnv(), fetchImpl)],
  ]) {
    await t.test(name, async () => {
      let calls = 0;
      const client = makeClient(async () => {
        calls += 1;
        return {
          ...jsonResponse({ error: { message: "retry later" } }, 429),
          headers: { get: () => "3" },
        };
      });
      await assert.rejects(client.request("/search"), (error) => error.code === "HTTP_429");
      assert.equal(calls, 1, "do not retry sooner than Retry-After permits");
    });
  }
});

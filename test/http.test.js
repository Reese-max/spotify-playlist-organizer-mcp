import assert from "node:assert/strict";
import test from "node:test";
import { fetchWithDeadline, ProviderRequestError } from "../src/http.js";
import { YouTubeClient } from "../src/youtube.js";

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { get: () => null },
    async text() {
      return JSON.stringify(data);
    },
  };
}

test("bounds a hanging provider request with a typed timeout", async () => {
  const started = Date.now();
  await assert.rejects(
    fetchWithDeadline(
      async () => new Promise(() => {}),
      "https://provider.test/hanging",
      {},
      { timeoutMs: 25, operation: "test request" },
    ),
    (error) => error instanceof ProviderRequestError && error.code === "TIMEOUT",
  );
  assert.ok(Date.now() - started < 500);
});

test("propagates caller cancellation without waiting for the provider", async () => {
  const controller = new AbortController();
  const promise = fetchWithDeadline(
    async () => new Promise(() => {}),
    "https://provider.test/cancelled",
    {},
    { signal: controller.signal, timeoutMs: 1000, operation: "test request" },
  );
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(
    promise,
    (error) => error instanceof ProviderRequestError && error.code === "CALLER_CANCELLED",
  );
});

test("retries a transient YouTube read once, but never retries a write", async () => {
  let readCalls = 0;
  const readClient = new YouTubeClient(
    { YOUTUBE_API_KEY: "test-key", PROVIDER_MAX_READ_RETRIES: "1" },
    async () => {
      readCalls += 1;
      return readCalls === 1
        ? { ...response({ error: { message: "temporary" } }, 503), headers: { get: () => "0" } }
        : response({ pageInfo: { totalResults: 0 }, items: [] });
    },
  );
  await readClient.searchVideos("focus");
  assert.equal(readCalls, 2);

  let writeCalls = 0;
  const writeClient = new YouTubeClient(
    { YOUTUBE_ACCESS_TOKEN: "user-token" },
    async () => {
      writeCalls += 1;
      return { ...response({ error: { message: "temporary" } }, 503), headers: { get: () => "0" } };
    },
  );
  await assert.rejects(
    writeClient.addVideoToPlaylist("PL123456789", "dQw4w9WgXcQ"),
    (error) => error.code === "HTTP_5XX" && error.status === 503,
  );
  assert.equal(writeCalls, 1);
});

test("bounds a hanging provider response body", async () => {
  const client = new YouTubeClient(
    { YOUTUBE_API_KEY: "test-key", PROVIDER_TIMEOUT_MS: "25" },
    async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => new Promise(() => {}),
    }),
  );
  await assert.rejects(
    client.searchVideos("focus"),
    (error) => error instanceof ProviderRequestError && error.code === "TIMEOUT",
  );
});

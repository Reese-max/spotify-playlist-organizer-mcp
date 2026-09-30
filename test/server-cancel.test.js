import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { createServer } from "../src/server.js";

// A provider fetch that never settles — the deterministic stall fixture the
// bounded-request contract is written against. Records the abort signal the
// client hands to the transport so tests can observe propagation.
function hangingFetch(observed) {
  return (url, options = {}) => {
    observed.push({ url, signal: options?.signal ?? null });
    return new Promise(() => {});
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(10);
  }
  return predicate();
}

function patchHarness(env, fetchImpl) {
  const savedFetch = globalThis.fetch;
  const savedEnv = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  globalThis.fetch = fetchImpl;
  Object.assign(process.env, env);
  return () => {
    globalThis.fetch = savedFetch;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function connectClient(server) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const pending = new Map();
  const inbound = [];
  let nextId = 0;
  clientTransport.onmessage = (message) => {
    if (message.id !== undefined && pending.has(message.id)) {
      const resolve = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
      return;
    }
    inbound.push(message);
  };
  const api = {
    inbound,
    sendRaw(message) {
      clientTransport.send(message);
    },
    request(method, params) {
      const id = ++nextId;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        clientTransport.send({ jsonrpc: "2.0", id, method, params });
      });
    },
    callTool(name, args) {
      return api.request("tools/call", { name, arguments: args });
    },
    // Fire-and-forget call — used for requests we expect to be cancelled; a
    // cancelled request is answered with silence, not a wire response.
    startTool(name, args) {
      const id = ++nextId;
      clientTransport.send({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      return id;
    },
    cancel(id, reason = "test-cancel") {
      clientTransport.send({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id, reason },
      });
    },
  };
  return { api, connect: () => server.connect(serverTransport) };
}

async function initialize(api) {
  const response = await api.request("initialize", {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "cancel-test", version: "0.0.0" },
  });
  assert.ok(response.result?.serverInfo);
  api.sendRaw({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
  await sleep(20);
}

test("notifications/cancelled aborts the in-flight provider request", { timeout: 20_000 }, async () => {
  const observed = [];
  const restore = patchHarness(
    { YOUTUBE_API_KEY: "cancel-test-api-key", PROVIDER_TIMEOUT_MS: "1200" },
    hangingFetch(observed),
  );
  try {
    const server = createServer({ status: () => ({ tracks: 0 }) });
    const { api, connect } = connectClient(server);
    await connect();
    await initialize(api);

    const id = api.startTool("youtube_search_videos", { query: "stall" });
    assert.ok(await waitFor(() => observed.length === 1), "provider fetch never started");
    await sleep(50);
    api.cancel(id);
    // The provider deadline is 1200ms; a cancel-driven abort must land well
    // inside that bound. On the unfixed path nothing aborts until the
    // deadline, so this window is the discrimination between the two.
    const aborted = await waitFor(() => observed[0].signal?.aborted === true, 800);
    assert.ok(
      aborted,
      "caller cancellation never reached the in-flight provider request",
    );

    // A cancelled request produces no wire response, and the server stays
    // responsive for the next call.
    await sleep(50);
    assert.ok(!api.inbound.some((message) => message.id === id));
    const status = await api.callTool("library_status", {});
    assert.ok(status.result);
    assert.equal(JSON.parse(status.result.content[0].text).tracks, 0);
  } finally {
    restore();
  }
});

test("a stalled provider read returns a typed TIMEOUT result within the deadline", { timeout: 20_000 }, async () => {
  const observed = [];
  const restore = patchHarness(
    { YOUTUBE_API_KEY: "timeout-test-api-key", PROVIDER_TIMEOUT_MS: "80" },
    hangingFetch(observed),
  );
  try {
    const server = createServer({ status: () => ({ tracks: 0 }) });
    const { api, connect } = connectClient(server);
    await connect();
    await initialize(api);

    const started = Date.now();
    const response = await api.callTool("youtube_search_videos", { query: "stall" });
    assert.ok(Date.now() - started < 5_000, "stalled read was not bounded");
    assert.equal(response.result.isError, true);
    const payload = JSON.parse(response.result.content[0].text);
    assert.equal(payload.code, "TIMEOUT");
    assert.equal(payload.retryable, true);
    assert.ok(!response.result.content[0].text.includes("timeout-test-api-key"));
  } finally {
    restore();
  }
});

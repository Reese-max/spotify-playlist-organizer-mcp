// http-server: a protected HTTP facade over the same domain/service layer the
// stdio MCP server uses (save-music, library-query, library-sync). Nothing in
// here re-implements business logic — every route delegates to the shared
// service functions, so preview/apply, exact IDs, and reconciliation semantics
// are identical over stdio and HTTP.
//
// Security model:
// - localhost-only binding by default (MUSIC_HTTP_HOST overrides explicitly)
// - Bearer session tokens, minted only by proving the bootstrap secret
// - session TTL + explicit revocation; sessions are unrelated to YouTube creds
// - default-deny Origin policy; CORS headers only for configured origins
// - bounded request bodies, JSON only; structured error envelope
// - bounded concurrency on effectful endpoints
// - request bodies are whitelisted per route — clients cannot inject
//   credential paths or other server-side parameters

import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadEnvFile } from "./env.js";
import { LibraryError, openLibrary } from "./library.js";
import {
  getMusic,
  listMusic,
  listUnsyncedMusic,
  recentMusic,
  reclassifyMusic,
  removeMusic,
  searchLibrary,
  updateMusicTags,
} from "./library-query.js";
import { reconcileTrack, syncStatus, syncYoutube } from "./library-sync.js";
import { saveMusic } from "./save-music.js";
import { YouTubeClient } from "./youtube.js";

const SERVER_NAME = "music-playlist-organizer";
const SERVER_VERSION = "0.2.0";
const DEFAULT_BODY_LIMIT = 64 * 1024;
const DEFAULT_MAX_WRITES = 4;
const DEFAULT_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

export function createSessionStore({ ttlMs = DEFAULT_SESSION_TTL_MS, maxSessions = 32 } = {}) {
  const sessions = new Map(); // token -> expiresAt (ms epoch)
  const sweep = () => {
    const now = Date.now();
    for (const [token, expiresAt] of sessions) {
      if (expiresAt <= now) sessions.delete(token);
    }
  };
  return {
    issue() {
      sweep();
      if (sessions.size >= maxSessions) return null;
      const token = crypto.randomBytes(32).toString("hex");
      const expiresAt = Date.now() + ttlMs;
      sessions.set(token, expiresAt);
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    },
    check(token) {
      const expiresAt = sessions.get(token);
      if (expiresAt === undefined) return false;
      if (expiresAt <= Date.now()) {
        sessions.delete(token);
        return false;
      }
      return true;
    },
    revoke(token) {
      sessions.delete(token);
    },
  };
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    ...headers,
  });
  response.end(payload);
}

function sendError(response, status, code, message, headers = {}) {
  sendJson(response, status, { error: { code, message } }, headers);
}

function readBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        // Keep draining so the socket stays alive long enough to answer 413.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    request.on("end", () => {
      if (tooLarge) {
        reject(new HttpError(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${limit} bytes.`));
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("error", reject);
  });
}

async function readJsonBody(request, limit) {
  const text = await readBody(request, limit);
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new HttpError(400, "BAD_REQUEST", "Request body must be a JSON object.");
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "BAD_REQUEST", "Request body is not valid JSON.");
  }
}

// Only these keys may cross the HTTP boundary into each service call.
function pick(body, keys) {
  const args = {};
  for (const key of keys) {
    if (body[key] !== undefined) args[key] = body[key];
  }
  return args;
}

function numericParams(query, keys = ["limit", "offset"]) {
  const params = {};
  for (const key of keys) {
    const raw = query.get(key);
    if (raw !== null) {
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new HttpError(400, "BAD_REQUEST", `Query parameter ${key} must be numeric.`);
      }
      params[key] = value;
    }
  }
  return params;
}

export function createHttpServer({
  library,
  youtube = new YouTubeClient(),
  bootstrapToken,
  sessionStore = createSessionStore(),
  allowedOrigins = ["http://localhost", "http://127.0.0.1"],
  maxConcurrentWrites = DEFAULT_MAX_WRITES,
  bodyLimit = DEFAULT_BODY_LIMIT,
} = {}) {
  if (!library) {
    throw new LibraryError("LIBRARY_INPUT_INVALID", "createHttpServer requires a library.");
  }
  const secret = typeof bootstrapToken === "string" && bootstrapToken
    ? bootstrapToken
    : crypto.randomBytes(24).toString("hex");

  const originAllowed = (origin) =>
    allowedOrigins.some((allowed) => origin === allowed || origin.startsWith(`${allowed}:`));
  const corsHeaders = (origin) =>
    origin && originAllowed(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Headers": "authorization, content-type",
          "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
          Vary: "Origin",
        }
      : {};

  let activeWrites = 0;
  const withWriteSlot = async (handler) => {
    if (activeWrites >= maxConcurrentWrites) {
      throw new HttpError(429, "RATE_LIMITED", "Too many concurrent write requests.");
    }
    activeWrites += 1;
    try {
      return await handler();
    } finally {
      activeWrites -= 1;
    }
  };

  const services = { library, youtube };

  // [method, pattern, {auth, write}, handler(params, body, query, signal)]
  const routes = [
    ["GET", "/health", { auth: false }, () => ({ status: "ok" })],
    ["GET", "/version", { auth: false }, () => ({ name: SERVER_NAME, version: SERVER_VERSION })],
    ["GET", "/api/library/tracks", { auth: true }, (_p, _b, q) =>
      listMusic(library, numericParams(q))],
    ["GET", "/api/library/recent", { auth: true }, (_p, _b, q) =>
      recentMusic(library, numericParams(q, ["limit"]))],
    ["GET", "/api/library/search", { auth: true }, (_p, _b, q) => {
      const params = numericParams(q);
      for (const key of ["title", "artist", "tag", "genre", "mood", "language", "activity"]) {
        const value = q.get(key);
        if (value !== null) params[key] = value;
      }
      return searchLibrary(library, params);
    }],
    ["GET", "/api/library/unsynced", { auth: true }, (_p, _b, q) => {
      const params = numericParams(q);
      const reason = q.get("reason");
      if (reason !== null) params.reason = reason;
      return listUnsyncedMusic(library, params);
    }],
    ["GET", /^\/api\/library\/tracks\/(\d+)$/, { auth: true }, (params) =>
      getMusic(library, { trackId: Number(params[0]) })],
    ["POST", /^\/api\/library\/tracks\/(\d+)\/tags$/, { auth: true, write: true }, (params, body) =>
      updateMusicTags(library, {
        trackId: Number(params[0]),
        ...pick(body, ["add", "remove"]),
      })],
    ["POST", /^\/api\/library\/tracks\/(\d+)\/reclassify$/, { auth: true, write: true }, (params, _b, _q, signal) =>
      reclassifyMusic(library, { trackId: Number(params[0]) }, { signal })],
    ["POST", "/api/library/remove", { auth: true, write: true }, (_p, body, _q, signal) =>
      removeMusic(services, pick(body, ["trackId", "mode", "local", "youtubePlaylist", "videoId"]), { signal })],
    ["POST", "/api/save_music", { auth: true, write: true }, (_p, body, _q, signal) =>
      saveMusic(services, pick(body, ["input", "videoId", "tags", "category", "playlist", "mode", "syncToYouTube"]), { signal })],
    ["GET", "/api/sync/status", { auth: true }, (_p, _b, q, signal) =>
      syncStatus(services, { playlist: q.get("playlist") ?? undefined }, { signal })],
    ["POST", "/api/sync", { auth: true, write: true }, (_p, body, _q, signal) =>
      syncYoutube(services, pick(body, ["mode", "direction", "playlist", "allowRemoval"]), { signal })],
    ["POST", "/api/reconcile", { auth: true, write: true }, (_p, body, _q, signal) =>
      reconcileTrack(services, pick(body, ["trackId", "videoId", "playlistId"]), { signal })],
  ];

  const server = http.createServer(async (request, response) => {
    const origin = request.headers.origin;
    const headers = corsHeaders(origin);
    try {
      // Default-deny origin policy: a browser request carrying an Origin that
      // is not configured is refused before any routing or auth work.
      if (origin && !originAllowed(origin)) {
        throw new HttpError(403, "ORIGIN_DENIED", "Origin is not in the allowed origins list.");
      }
      if (request.method === "OPTIONS") {
        response.writeHead(204, headers);
        response.end();
        return;
      }

      const url = new URL(request.url, "http://localhost");
      const route = routes.find(([method, pattern]) => {
        if (method !== request.method) return false;
        return typeof pattern === "string" ? pattern === url.pathname : pattern.test(url.pathname);
      });

      // Session bootstrap is the only endpoint authenticated by the shared
      // bootstrap secret rather than a session token.
      if (request.method === "POST" && url.pathname === "/session") {
        const body = await readJsonBody(request, bodyLimit);
        if (body.token !== secret) {
          throw new HttpError(401, "UNAUTHORIZED", "Invalid bootstrap token.");
        }
        const session = sessionStore.issue();
        if (!session) {
          throw new HttpError(429, "RATE_LIMITED", "Session limit reached.");
        }
        sendJson(response, 200, session, headers);
        return;
      }
      if (request.method === "DELETE" && url.pathname === "/session") {
        const token = bearerToken(request);
        if (!token || !sessionStore.check(token)) {
          throw new HttpError(401, "UNAUTHORIZED", "A valid session token is required.");
        }
        sessionStore.revoke(token);
        response.writeHead(204, headers);
        response.end();
        return;
      }

      if (!route) {
        throw new HttpError(404, "NOT_FOUND", `No route for ${request.method} ${url.pathname}.`);
      }
      const [, pattern, options, handler] = route;
      if (options.auth) {
        const token = bearerToken(request);
        if (!token || !sessionStore.check(token)) {
          throw new HttpError(401, "UNAUTHORIZED", "A valid session token is required.");
        }
      }

      const params = typeof pattern === "string" ? [] : pattern.exec(url.pathname).slice(1);
      const body = request.method === "GET" ? {} : await readJsonBody(request, bodyLimit);
      // Propagate client disconnects into the service layer as cancellation.
      // response 'close' fires on socket teardown, not on request completion.
      const abort = new AbortController();
      response.on("close", () => abort.abort());
      const run = () => handler(params, body, url.searchParams, abort.signal);
      const result = options.write ? await withWriteSlot(run) : await run();
      sendJson(response, 200, result, headers);
    } catch (error) {
      const status = error instanceof HttpError
        ? error.status
        : error instanceof LibraryError
          ? 400
          : 500;
      const code = error instanceof HttpError
        ? error.code
        : error instanceof LibraryError
          ? error.code
          : "INTERNAL_ERROR";
      sendError(response, status, code, status === 500 ? "Internal server error." : error.message, headers);
    }
  });
  return server;
}

function bearerToken(request) {
  const header = request.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return null;
  return header.slice("Bearer ".length).trim() || null;
}

export async function main(env = process.env) {
  if (env === process.env) loadEnvFile();
  const library = openLibrary(env);
  const host = env.MUSIC_HTTP_HOST || "127.0.0.1";
  const port = Number(env.MUSIC_HTTP_PORT || 8741);
  const bootstrapToken = env.MUSIC_HTTP_BOOTSTRAP_TOKEN || crypto.randomBytes(24).toString("hex");
  const allowedOrigins = env.MUSIC_HTTP_ALLOWED_ORIGINS
    ? env.MUSIC_HTTP_ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
    : undefined;
  const server = createHttpServer({
    library,
    bootstrapToken,
    ...(allowedOrigins ? { allowedOrigins } : {}),
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  // Bootstrap token is printed once for the local operator — never in API
  // responses, and the session store never sees provider credentials.
  process.stderr.write(
    `music-library HTTP listening on http://${host}:${port}\n` +
    `MUSIC_HTTP_BOOTSTRAP_TOKEN=${bootstrapToken}\n`,
  );
  const shutdown = () => {
    server.close(() => {
      library.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entry && import.meta.url === pathToFileURL(entry).href) {
  await main();
}

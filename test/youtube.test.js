import assert from "node:assert/strict";
import test from "node:test";
import {
  parseYouTubePlaylistReference,
  parseYouTubeVideoReference,
  YouTubeClient,
} from "../src/youtube.js";

function response(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    async text() {
      return JSON.stringify(data);
    },
  };
}

test("parses YouTube video and playlist references", () => {
  assert.equal(parseYouTubeVideoReference("dQw4w9WgXcQ").id, "dQw4w9WgXcQ");
  assert.equal(
    parseYouTubeVideoReference("https://music.youtube.com/watch?v=dQw4w9WgXcQ").id,
    "dQw4w9WgXcQ",
  );
  assert.equal(
    parseYouTubePlaylistReference("https://www.youtube.com/playlist?list=PL123456789").id,
    "PL123456789",
  );
  assert.equal(parseYouTubePlaylistReference("我的 Chill 歌單").name, "我的 Chill 歌單");
});

test("searches YouTube with an API key and normalizes video results", async () => {
  const calls = [];
  const client = new YouTubeClient(
    { YOUTUBE_API_KEY: "test-key", YOUTUBE_REGION: "TW" },
    async (url, options) => {
      calls.push({ url, options });
      return response({
        pageInfo: { totalResults: 1 },
        items: [{
          id: { videoId: "dQw4w9WgXcQ" },
          snippet: {
            title: "Focus Piano",
            channelTitle: "Example Channel",
            description: "A focused track",
          },
        }],
      });
    },
  );

  const result = await client.searchVideos("focus piano", { limit: 1 });
  assert.equal(result.total, 1);
  assert.equal(result.videos[0].id, "dQw4w9WgXcQ");
  assert.equal(result.videos[0].artists[0], "Example Channel");
  assert.equal(result.videos[0].url, "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  assert.match(calls[0].url, /key=test-key/);
  assert.match(calls[0].url, /type=video/);
});

test("lists, creates, and adds to playlists with a user OAuth token", async () => {
  const calls = [];
  const client = new YouTubeClient(
    { YOUTUBE_ACCESS_TOKEN: "user-token" },
    async (url, options) => {
      calls.push({ url, options });
      if (options.method === "POST" && url.includes("/playlists?")) {
        return response({
          id: "PL_CREATED",
          snippet: { title: "Chill", description: "Managed playlist" },
          status: { privacyStatus: "private" },
        });
      }
      if (options.method === "POST" && url.includes("/playlistItems?")) {
        return response({
          id: "item-1",
          snippet: {
            title: "Focus Piano",
            channelTitle: "Example Channel",
            resourceId: { videoId: "dQw4w9WgXcQ" },
          },
        });
      }
      return response({
        pageInfo: { totalResults: 1 },
        items: [{
          id: "PL_EXISTING",
          snippet: { title: "Existing", description: "" },
          contentDetails: { itemCount: 0 },
          status: { privacyStatus: "private" },
        }],
      });
    },
  );

  const listed = await client.listPlaylists({ limit: 10 });
  const created = await client.createPlaylist("Chill", "Managed playlist", "private");
  const added = await client.addVideoToPlaylist("PL_CREATED", "dQw4w9WgXcQ");

  assert.equal(listed.playlists[0].id, "PL_EXISTING");
  assert.equal(created.id, "PL_CREATED");
  assert.equal(added.id, "dQw4w9WgXcQ");
  assert.equal(calls[0].options.headers.Authorization, "Bearer user-token");
  assert.equal(calls[1].options.method, "POST");
  assert.equal(JSON.parse(calls[1].options.body).snippet.title, "Chill");
  assert.equal(JSON.parse(calls[2].options.body).snippet.resourceId.videoId, "dQw4w9WgXcQ");
});

function env(overrides = {}) {
  return {
    YOUTUBE_CREDENTIAL_FILE: "C:/nonexistent-test-dir/no-credentials.json",
    ...overrides,
  };
}

test("retries a GET once on 5xx and surfaces the successful response", async () => {
  const calls = [];
  const client = new YouTubeClient(env({ YOUTUBE_API_KEY: "k" }), async (url) => {
    calls.push(url);
    if (calls.length === 1) {
      return {
        ok: false,
        status: 500,
        headers: { get: (name) => (name === "retry-after" ? "0" : null) },
        async text() { return JSON.stringify({ error: { message: "backend" } }); },
      };
    }
    return response({ items: [{ id: "V_RETRY0001", snippet: { title: "Recovered" } }] });
  });

  const video = await client.getVideo("V_RETRY0001");
  assert.equal(video.id, "V_RETRY0001");
  assert.equal(calls.length, 2);
});

test("does not retry POST writes and throws a typed YouTubeApiError", async () => {
  const calls = [];
  const client = new YouTubeClient(env({ YOUTUBE_ACCESS_TOKEN: "t" }), async (url, options) => {
    calls.push(options.method);
    return response({ error: { message: "quota gone" } }, 500);
  });

  await assert.rejects(
    () => client.createPlaylist("X"),
    (error) => error.name === "YouTubeApiError" && error.status === 500 && error.code === "HTTP_5XX",
  );
  assert.equal(calls.length, 1);
});

test("refreshes the user token on 401 and retries with the new bearer token", async () => {
  const authHeaders = [];
  const tokenPosts = [];
  const client = new YouTubeClient(
    env({
      YOUTUBE_ACCESS_TOKEN: "stale-token",
      YOUTUBE_REFRESH_TOKEN: "refresh-1",
      GOOGLE_CLIENT_ID: "cid",
      GOOGLE_CLIENT_SECRET: "csecret",
    }),
    async (url, options) => {
      if (url.startsWith("https://oauth2.googleapis.com/token")) {
        tokenPosts.push(String(options.body));
        return response({ access_token: "fresh-token", expires_in: 3600 });
      }
      authHeaders.push(options.headers.Authorization);
      if (authHeaders.length === 1) {
        return response({ error: { message: "expired" } }, 401);
      }
      return response({ items: [{ id: "V_AFTER401", snippet: { title: "Ok" } }] });
    },
  );

  const video = await client.getVideo("V_AFTER401");
  assert.equal(video.id, "V_AFTER401");
  assert.equal(tokenPosts.length, 1);
  assert.match(tokenPosts[0], /grant_type=refresh_token/);
  assert.match(tokenPosts[0], /refresh_token=refresh-1/);
  assert.deepEqual(authHeaders, ["Bearer stale-token", "Bearer fresh-token"]);
});

test("throws a typed error when no user credential is available", async () => {
  const client = new YouTubeClient(env(), async () => {
    throw new Error("fetch must not be called");
  });
  await assert.rejects(
    () => client.getPlaylist("PL_ANY00000000"),
    /user token is required/i,
  );
});

test("getVideo throws when the provider returns no items", async () => {
  const client = new YouTubeClient(
    env({ YOUTUBE_API_KEY: "k" }),
    async () => response({ items: [] }),
  );
  await assert.rejects(() => client.getVideo("V_MISSING001"), /not found/);
});

test("getPlaylistItems follows pageToken and stops at the final page", async () => {
  const seenTokens = [];
  const client = new YouTubeClient(env({ YOUTUBE_ACCESS_TOKEN: "t" }), async (url) => {
    seenTokens.push(new URL(url).searchParams.get("pageToken"));
    if (seenTokens.length === 1) {
      return response({
        nextPageToken: "PAGE2",
        items: [{ snippet: { title: "P1" }, contentDetails: { videoId: "V_PAGE00001" } }],
      });
    }
    return response({
      items: [{ snippet: { title: "P2" }, contentDetails: { videoId: "V_PAGE00002" } }],
    });
  });

  const items = await client.getPlaylistItems("PL_PAGE0000001");
  assert.deepEqual(items.map((item) => item.id), ["V_PAGE00001", "V_PAGE00002"]);
  assert.deepEqual(seenTokens, [null, "PAGE2"]);
});

test("removeVideoFromPlaylist deletes by playlist-item id and reports not_in_playlist", async () => {
  const deletes = [];
  let pages = 0;
  const client = new YouTubeClient(env({ YOUTUBE_ACCESS_TOKEN: "t" }), async (url, options) => {
    if (options.method === "DELETE") {
      deletes.push(new URL(url).searchParams.get("id"));
      return response(null);
    }
    pages += 1;
    return response({
      items: [{
        id: "item-99",
        contentDetails: { videoId: "V_TARGET001" },
        snippet: { title: "X" },
      }],
    });
  });

  const removed = await client.removeVideoFromPlaylist("PL_RM00000001", "V_TARGET001");
  assert.equal(removed.removed, true);
  assert.equal(removed.playlistItemId, "item-99");
  assert.deepEqual(deletes, ["item-99"]);

  const missing = await client.removeVideoFromPlaylist("PL_RM00000001", "V_OTHER0001");
  assert.equal(missing.removed, false);
  assert.equal(missing.reason, "not_in_playlist");
  assert.equal(pages, 2);
  assert.equal(deletes.length, 1);
});

test("renamePlaylist and deletePlaylist issue exact-ID PUT/DELETE calls", async () => {
  const calls = [];
  const client = new YouTubeClient(env({ YOUTUBE_ACCESS_TOKEN: "t" }), async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    if (options.method === "PUT") {
      return response({ id: "PL_RENAMED001", snippet: { title: "New Name" }, status: {} });
    }
    return response(null);
  });

  const renamed = await client.renamePlaylist("PL_RENAMED001", "New Name");
  const deleted = await client.deletePlaylist("PL_RENAMED001");
  assert.equal(renamed.name, "New Name");
  assert.equal(calls[0].method, "PUT");
  assert.equal(calls[0].body.id, "PL_RENAMED001");
  assert.equal(calls[0].body.snippet.title, "New Name");
  assert.equal(calls[1].method, "DELETE");
  assert.match(calls[1].url, /id=PL_RENAMED001/);
  assert.deepEqual(deleted, { deleted: true, playlistId: "PL_RENAMED001" });
});

test("revokeUserCredentials revokes the token and clears env credentials", async () => {
  const revokePosts = [];
  const credentialsEnv = env({
    YOUTUBE_ACCESS_TOKEN: "acc",
    YOUTUBE_REFRESH_TOKEN: "ref",
  });
  const client = new YouTubeClient(credentialsEnv, async (url, options) => {
    revokePosts.push({ url, body: String(options.body) });
    return response(null);
  });

  const result = await client.revokeUserCredentials();
  assert.equal(result.status, "REVOKED");
  assert.equal(result.source, "environment");
  assert.match(revokePosts[0].url, /oauth2.googleapis.com\/revoke/);
  assert.match(revokePosts[0].body, /token=(acc|ref)/);
  assert.equal(credentialsEnv.YOUTUBE_ACCESS_TOKEN, undefined);
  assert.equal(credentialsEnv.YOUTUBE_REFRESH_TOKEN, undefined);
});

test("revokeUserCredentials reports MISSING when nothing is stored", async () => {
  const client = new YouTubeClient(env(), async () => {
    throw new Error("fetch must not be called");
  });
  const result = await client.revokeUserCredentials();
  assert.equal(result.status, "MISSING");
  assert.equal(result.localCredentialsDeleted, false);
});

test("credentialStatus reports the environment source", async () => {
  const client = new YouTubeClient(env({ YOUTUBE_ACCESS_TOKEN: "t" }), async () => {
    throw new Error("fetch must not be called");
  });
  const status = await client.credentialStatus();
  assert.equal(status.status, "READY");
  assert.equal(status.source, "environment");
});

test("findPlaylistByName matches case-insensitively across whitespace", async () => {
  const client = new YouTubeClient(env({ YOUTUBE_ACCESS_TOKEN: "t" }), async () =>
    response({
      items: [{ id: "PL_NAME000001", snippet: { title: "My  Chill   Mix" }, status: {} }],
    }));
  const found = await client.findPlaylistByName("my chill mix");
  assert.equal(found.id, "PL_NAME000001");
  const missing = await client.findPlaylistByName("nope", { playlists: [{ name: "other" }] });
  assert.equal(missing, null);
});

test("parseYouTubeVideoReference rejects playlist input with a clear error", () => {
  assert.throws(
    () => parseYouTubeVideoReference("https://www.youtube.com/playlist?list=PL123456789"),
    /playlist/i,
  );
});

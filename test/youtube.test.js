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

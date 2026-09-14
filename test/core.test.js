import assert from "node:assert/strict";
import test from "node:test";
import { classifyItems, findDuplicates, parseLink, parsePlaylistId } from "../src/core.js";

test("parses Spotify, YouTube, YouTube Music, and plain search inputs", () => {
  assert.deepEqual(parseLink("https://open.spotify.com/intl-zh/track/abc123?si=ignored"), {
    kind: "spotify-track",
    id: "abc123",
    uri: "spotify:track:abc123",
    url: "https://open.spotify.com/track/abc123",
  });
  assert.deepEqual(parseLink("https://youtu.be/video123?t=20"), {
    kind: "youtube-video",
    id: "video123",
    url: "https://youtu.be/video123?t=20",
  });
  assert.deepEqual(parseLink("https://music.youtube.com/watch?v=video123&list=PL123"), {
    kind: "youtube-video",
    id: "video123",
    url: "https://music.youtube.com/watch?v=video123&list=PL123",
  });
  assert.deepEqual(parseLink("Daft Punk One More Time"), {
    kind: "query",
    query: "Daft Punk One More Time",
  });
  assert.equal(parsePlaylistId("spotify:playlist:playlist123"), "playlist123");
});

test("finds duplicate Spotify and YouTube items and keeps playlist positions", () => {
  const items = [
    { track: { id: "one", name: "One", artists: [{ name: "Artist" }] } },
    { id: "video123", name: "Video", artists: ["Channel"], platform: "youtube" },
    { item: { id: "one", name: "One", artists: [{ name: "Artist" }] } },
    { id: "video123", name: "Video", artists: ["Channel"], platform: "youtube" },
  ];
  const result = findDuplicates(items);
  assert.equal(result.duplicateGroups, 2);
  assert.equal(result.duplicateItemCount, 2);
  assert.deepEqual(result.duplicates.map((group) => group.map((track) => track.position)), [[1, 3], [2, 4]]);
});

test("classifies tracks deterministically with custom rules", () => {
  const result = classifyItems([
    { track: { id: "one", name: "Morning Focus", artists: [{ name: "A" }] } },
    { track: { id: "two", name: "Night Drive", artists: [{ name: "B" }] } },
  ], { Focus: ["focus"], Drive: ["drive"] });
  assert.deepEqual(result.counts, { Focus: 1, Drive: 1 });
  assert.deepEqual(result.assignments.map((track) => track.category), ["Focus", "Drive"]);
});

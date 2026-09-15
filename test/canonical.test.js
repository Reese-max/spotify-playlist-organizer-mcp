import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeSource,
  normalizeArtist,
  normalizeText,
  tokenContainment,
  tokenSimilarity,
} from "../src/canonical.js";

test("official MV and official audio share one canonical key", () => {
  const video = canonicalizeSource({
    title: "One More Time (Official Video)",
    artist: "Daft Punk",
  });
  const audio = canonicalizeSource({
    title: "One More Time (Official Audio)",
    artist: "Daft Punk",
  });
  assert.equal(video.canonicalKey, audio.canonicalKey);
  assert.equal(video.sourceType, "official_video");
  assert.equal(audio.sourceType, "official_audio");
  assert.equal(video.version, "");
});

test("live, cover, remix, and remaster change the canonical key", () => {
  const base = canonicalizeSource({ title: "Song", artist: "Artist" });
  for (const [title, type] of [
    ["Song (Live at Wembley)", "live"],
    ["Song (Live)", "live"],
    ["Song (Cover)", "cover"],
    ["Song (Kygo Remix)", "remix"],
    ["Song (Remastered 2011)", "remaster"],
    ["Song [MV] - 翻唱", "cover"],
  ]) {
    const variant = canonicalizeSource({ title, artist: "Artist" });
    assert.equal(variant.sourceType, type, title);
    assert.notEqual(variant.canonicalKey, base.canonicalKey, title);
  }
  const wembley = canonicalizeSource({ title: "Song (Live at Wembley)", artist: "Artist" });
  const plainLive = canonicalizeSource({ title: "Song (Live)", artist: "Artist" });
  assert.equal(wembley.version, "live:at wembley");
  assert.equal(plainLive.version, "live");
});

test("punctuation, case, and feat. differences do not change the key", () => {
  const base = canonicalizeSource({ title: "One More Time", artist: "Daft Punk" });
  for (const title of [
    "ONE MORE TIME!!!",
    "One More Time (feat. Romanthony)",
    "One More Time ft. Romanthony",
    "one   more   time",
    "One More Time (Official Video) [HD]",
  ]) {
    const variant = canonicalizeSource({ title, artist: "DAFT PUNK" });
    assert.equal(variant.canonicalKey, base.canonicalKey, title);
  }
  const featured = canonicalizeSource({
    title: "One More Time (feat. Romanthony)",
    artist: "Daft Punk",
  });
  assert.deepEqual(featured.features, ["romanthony"]);
});

test("CJK and compatibility characters normalize into the same key", () => {
  const japanese = canonicalizeSource({ title: "夜に駆ける (Official Music Video)", artist: "YOASOBI" });
  const fullWidth = canonicalizeSource({ title: "夜に駆ける", artist: "ＹＯＡＳＯＢＩ" });
  assert.equal(japanese.canonicalKey, fullWidth.canonicalKey);
  assert.equal(japanese.sourceType, "official_video");

  const halfWidth = canonicalizeSource({ title: "夜に駆ける", artist: "ﾖｱｿﾋﾞ" });
  assert.equal(halfWidth.normalizedArtist, "ヨアソビ");

  const lyrics = canonicalizeSource({ title: "夜に駆ける 【歌詞】", artist: "YOASOBI" });
  assert.equal(lyrics.sourceType, "lyrics");
  assert.equal(lyrics.canonicalKey, japanese.canonicalKey);

  const diacritics = canonicalizeSource({ title: "Halo", artist: "Beyoncé" });
  assert.equal(diacritics.normalizedArtist, "beyonce");
});

test("artist - title splitting, - Topic suffix, and channel fallback", () => {
  const combined = canonicalizeSource({ title: "Daft Punk - One More Time (Official Video)" });
  assert.equal(combined.normalizedArtist, "daft punk");
  assert.equal(combined.normalizedTitle, "one more time");
  assert.equal(combined.sourceType, "official_video");

  const topic = canonicalizeSource({ title: "Song", artist: "Some Artist - Topic" });
  assert.equal(topic.normalizedArtist, "some artist");
  assert.equal(topic.sourceType, "unknown");

  const fromChannel = canonicalizeSource({ title: "Song", channelTitle: "Some Artist - Topic" });
  assert.equal(fromChannel.normalizedArtist, "some artist");
  assert.equal(fromChannel.sourceType, "official_audio");

  const redundantPrefix = canonicalizeSource({
    title: "Daft Punk - One More Time (Official Video)",
    artist: "Daft Punk",
  });
  assert.equal(redundantPrefix.normalizedTitle, "one more time");
  assert.equal(redundantPrefix.canonicalKey, combined.canonicalKey);
});

test("distinct songs keep distinct keys", () => {
  const a = canonicalizeSource({ title: "Thriller", artist: "Michael Jackson" });
  const b = canonicalizeSource({ title: "Billie Jean", artist: "Michael Jackson" });
  const c = canonicalizeSource({ title: "Thriller", artist: "Other Artist" });
  assert.notEqual(a.canonicalKey, b.canonicalKey);
  assert.notEqual(a.canonicalKey, c.canonicalKey);
});

test("normalizeText and token helpers", () => {
  assert.equal(normalizeText("  Héllo,  WORLD! "), "hello world");
  assert.equal(normalizeText("don't stop"), "dont stop");
  assert.equal(normalizeArtist("The Beatles"), "beatles");
  assert.equal(normalizeArtist("A and B"), "a b");
  assert.equal(normalizeArtist("A & B"), "a b");
  assert.equal(normalizeArtist("X Japan"), "x japan");
  assert.ok(tokenSimilarity("one more time", "one more night") > 0);
  assert.equal(tokenSimilarity("abc", "xyz"), 0);
  assert.ok(tokenContainment("song", "song subtitle"));
  assert.ok(!tokenContainment("song a", "song b"));
});

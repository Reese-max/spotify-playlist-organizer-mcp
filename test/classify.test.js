import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  classificationResultSchema,
  classificationSyncKey,
  classificationToTrackFields,
  classifyMusic,
  mergeClassification,
  persistClassification,
  validateClassification,
} from "../src/classify.js";
import { DIMENSIONS, TAXONOMY_VERSION } from "../src/taxonomy.js";
import { openLibrary } from "../src/library.js";

async function tempLibrary() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "music-classify-"));
  return { directory, filePath: path.join(directory, "library.sqlite") };
}

test("one track yields many dimensions at once, each with source and confidence", async () => {
  const result = await classifyMusic({
    title: "アイドル J-POP workout remix 2023",
    artist: "YOASOBI",
    channelTitle: "Ayase",
    description: "energetic dance track",
  });

  const nonEmpty = DIMENSIONS.filter((dimension) => result.dimensions[dimension].length > 0);
  assert.ok(nonEmpty.length >= 4, `expected >=4 dimensions, got ${nonEmpty.join(",")}`);
  assert.ok(result.dimensions.genre.some((entry) => entry.value === "j-pop"));
  assert.ok(result.dimensions.activity.some((entry) => entry.value === "workout"));
  assert.ok(result.dimensions.era.some((entry) => entry.value === "2020s"));
  assert.ok(result.dimensions.language.some((entry) => entry.value === "ja"));

  for (const dimension of DIMENSIONS) {
    for (const entry of result.dimensions[dimension]) {
      assert.ok(["user", "rule", "model"].includes(entry.source));
      assert.ok(entry.confidence >= 0 && entry.confidence <= 1);
    }
    const expected = result.dimensions[dimension][0]?.source ?? null;
    assert.equal(result.provenance[dimension], expected);
  }
  assert.equal(result.taxonomyVersion, TAXONOMY_VERSION);
  assert.doesNotThrow(() => validateClassification(result));
});

test("schema rejects classifier output that invents official values", async () => {
  const result = await classifyMusic({ title: "plain song", artist: "someone" });
  const parsed = classificationResultSchema.safeParse(result);
  assert.equal(parsed.success, true);

  const corrupted = structuredClone(result);
  corrupted.dimensions.genre.push({ value: "invented-genre", source: "rule", confidence: 0.9 });
  assert.equal(classificationResultSchema.safeParse(corrupted).success, false);

  const badConfidence = structuredClone(result);
  badConfidence.dimensions.mood.push({ value: "happy", source: "rule", confidence: 1.5 });
  assert.equal(classificationResultSchema.safeParse(badConfidence).success, false);
});

test("user-supplied synonyms normalize and always win over rule matches", async () => {
  const result = await classifyMusic({
    title: "hardcore edm banger workout",
    userClassification: { genre: "J-POP", mood: ["melancholic"] },
  });
  assert.deepEqual(
    result.dimensions.genre.map((entry) => entry.value),
    ["j-pop"],
  );
  assert.equal(result.dimensions.genre[0].source, "user");
  assert.equal(result.dimensions.genre[0].confidence, 1);
  assert.equal(result.provenance.genre, "user");
  assert.deepEqual(result.dimensions.mood.map((entry) => entry.value), ["melancholy"]);
  // Dimensions the user did not set still get rule fills.
  assert.ok(result.dimensions.activity.some((entry) => entry.value === "workout"));
  assert.equal(result.provenance.activity, "rule");
});

test("unrecognized values divert to custom_tags and needsReview", async () => {
  const result = await classifyMusic({
    title: "ordinary title",
    userClassification: { genre: "hyperpop", mood: "sultry" },
  });
  assert.equal(result.dimensions.genre.length, 0);
  assert.equal(result.dimensions.mood.length, 0);
  const tags = result.dimensions.custom_tags.map((entry) => entry.value);
  assert.ok(tags.includes("hyperpop"));
  assert.ok(tags.includes("sultry"));
  const diverted = result.dimensions.custom_tags.find((entry) => entry.value === "hyperpop");
  assert.equal(diverted.source, "user");
  assert.equal(diverted.needsReview, true);
  assert.ok(result.needsReview.some(
    (entry) => entry.dimension === "genre" && entry.value === "hyperpop" && entry.source === "user",
  ));
  // The diverted text never lands in a closed dimension.
  assert.equal(validateClassification(result).dimensions.genre.length, 0);
});

test("fallback works with no model and when a model throws", async () => {
  const input = { title: "lofi sleep beats", channelTitle: "some channel" };
  const baseline = await classifyMusic(input);
  assert.equal(baseline.provenance.genre, "rule");
  assert.ok(baseline.dimensions.genre.some((entry) => entry.value === "lo-fi"));

  const withBrokenModel = await classifyMusic({
    ...input,
    model: () => { throw new Error("model offline"); },
  });
  assert.deepEqual(withBrokenModel.dimensions, baseline.dimensions);
  assert.deepEqual(withBrokenModel.provenance, baseline.provenance);
});

test("a local model stub fills empty dimensions but never overrides the user", async () => {
  const model = () => ({ genre: "jazz", mood: { value: "dreamy", confidence: 0.62 } });
  const result = await classifyMusic({
    title: "obscure title with no keywords",
    model,
    userClassification: { genre: "rock" },
  });
  assert.deepEqual(result.dimensions.genre.map((entry) => entry.value), ["rock"]);
  assert.equal(result.provenance.genre, "user");
  assert.deepEqual(result.dimensions.mood, [
    { value: "dreamy", source: "model", confidence: 0.62 },
  ]);
  assert.equal(result.provenance.mood, "model");

  const invented = await classifyMusic({
    title: "x",
    model: () => ({ genre: "made-up-genre" }),
  });
  assert.equal(invented.dimensions.genre.length, 0);
  assert.ok(invented.needsReview.some(
    (entry) => entry.dimension === "genre" && entry.value === "made-up-genre" && entry.source === "model",
  ));
});

test("provider metadata is evidence, not ground truth", async () => {
  const byArtist = await classifyMusic({ title: "song", artist: "YOASOBI" });
  assert.deepEqual(byArtist.dimensions.artist, [{
    value: "YOASOBI",
    source: "rule",
    confidence: 0.8,
    evidence: { field: "artist", note: "provider_metadata" },
  }]);

  const byChannel = await classifyMusic({ title: "song", channelTitle: "Topic Channel" });
  assert.equal(byChannel.dimensions.artist[0].value, "Topic Channel");
  assert.ok(byChannel.dimensions.artist[0].confidence < 0.8);
});

test("save + reclassify fixture: user labels survive automatic reclassification", async () => {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  try {
    const trackInput = {
      title: "Idol - J-POP dance remix",
      artist: "YOASOBI",
      source: { provider: "youtube", sourceId: "fixture-video-1", url: "https://youtu.be/fixture-video-1" },
    };

    const classified = await classifyMusic({
      ...trackInput,
      channelTitle: "Ayase",
      userClassification: { genre: "J-POP", mood: "nostalgic" },
    });
    const saved = persistClassification(library, trackInput, classified);
    assert.equal(saved.track.genre, "j-pop");
    assert.equal(saved.track.mood, "nostalgic");
    assert.equal(saved.track.artist, "YOASOBI");
    assert.ok(saved.trackId > 0);

    const stored = JSON.parse(library.getSyncState(classificationSyncKey(saved.trackId)));
    assert.equal(stored.taxonomyVersion, TAXONOMY_VERSION);
    assert.equal(stored.provenance.genre, "user");
    assert.equal(stored.provenance.mood, "user");

    // Later automatic reclassify disagrees on every dimension.
    const reclassified = await classifyMusic({
      title: "sad lofi sleep ballad 90s",
      channelTitle: "unrelated channel",
    });
    assert.ok(reclassified.dimensions.genre.some((entry) => entry.value === "lo-fi"));
    assert.ok(reclassified.dimensions.mood.some((entry) => entry.value === "sad"));

    const repersisted = persistClassification(library, trackInput, reclassified);
    assert.equal(repersisted.track.id, saved.track.id);
    // User-set labels are preserved; empty dimensions get the new rule fills.
    assert.equal(repersisted.track.genre, "j-pop");
    assert.equal(repersisted.track.mood, "nostalgic");
    assert.equal(repersisted.track.era, "1990s");
    assert.equal(repersisted.track.activity, "sleep");
    assert.ok(repersisted.preserved.includes("genre"));
    assert.ok(repersisted.preserved.includes("mood"));

    const merged = JSON.parse(library.getSyncState(classificationSyncKey(saved.trackId)));
    assert.equal(merged.provenance.genre, "user");
    assert.equal(merged.provenance.mood, "user");
    assert.equal(merged.provenance.era, "rule");

    // Tags accumulate and nothing is removed by reclassification.
    const tags = library.listTags(saved.trackId);
    assert.deepEqual(tags, [...new Set(tags)].sort());
    assert.ok(tags.includes("remix"));
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("persistClassification is idempotent for the same classification", async () => {
  const { directory, filePath } = await tempLibrary();
  const library = openLibrary(filePath);
  try {
    const trackInput = {
      title: "Ditto",
      artist: "NewJeans",
      source: { provider: "youtube", sourceId: "fixture-video-2" },
    };
    const classified = await classifyMusic({ ...trackInput, userClassification: { custom_tags: ["winter"] } });
    const first = persistClassification(library, trackInput, classified);
    const second = persistClassification(library, trackInput, classified);
    assert.equal(first.trackId, second.trackId);
    assert.equal(library.trackCount(), 1);
    assert.deepEqual(library.listTags(first.trackId), ["winter"]);
  } finally {
    library.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("mergeClassification keeps prior user values and refreshes rule values", async () => {
  const prior = await classifyMusic({
    title: "x",
    userClassification: { genre: "k-pop", energy: "high" },
  });
  const next = await classifyMusic({ title: "calm ambient sleep" });
  const merged = mergeClassification(prior, next);
  assert.deepEqual(merged.dimensions.genre.map((entry) => entry.value), ["k-pop"]);
  assert.equal(merged.provenance.genre, "user");
  assert.deepEqual(merged.dimensions.energy.map((entry) => entry.value), ["high"]);
  assert.ok(merged.dimensions.activity.some((entry) => entry.value === "sleep"));
  assert.equal(merged.provenance.activity, "rule");
  assert.doesNotThrow(() => validateClassification(merged));
});

test("classificationToTrackFields maps only populated dimensions", async () => {
  const result = await classifyMusic({ title: "kpop dance practice" });
  const fields = classificationToTrackFields(result);
  assert.equal(fields.genre, "k-pop");
  assert.equal(fields.artist, undefined);
  assert.equal(fields.language, "ko");
  for (const field of Object.keys(fields)) {
    assert.ok(["genre", "mood", "language", "activity", "energy", "era", "artist"].includes(field));
  }
});

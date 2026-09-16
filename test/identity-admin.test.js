import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openLibrary } from "../src/library.js";
import {
  listIdentityReviews,
  mergeMusicTracks,
  resolveIdentityReview,
  setIdentityLock,
  splitMusicTrack,
} from "../src/identity-admin.js";

const VID_A = "V_IDENT00001";
const VID_B = "V_IDENT00002";
const VID_C = "V_IDENT00003";

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "music-identity-"));
  const library = openLibrary(path.join(directory, "library.sqlite"));
  const trackA = library.upsertTrack({
    title: "Song Alpha",
    artist: "Artist A",
    source: { provider: "youtube", sourceId: VID_A },
  }).track;
  const trackB = library.upsertTrack({
    title: "Song Beta",
    artist: "Artist B",
    source: { provider: "youtube", sourceId: VID_B },
  }).track;
  t.after(async () => {
    library.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { library, trackA, trackB };
}

function seedPair(library, trackA, trackB) {
  library.recordCandidate(trackA.id, trackB.id, 0.7, "fuzzy_title", new Date().toISOString());
  library.setNeedsReview(trackA.id, true);
}

test("list_identity_reviews returns pairs with confidence, reason, and both sides' sources", async (t) => {
  const { library, trackA, trackB } = await fixture(t);
  seedPair(library, trackA, trackB);

  const result = listIdentityReviews(library);
  assert.equal(result.count, 1);
  const item = result.items[0];
  assert.equal(item.trackId, trackA.id);
  assert.equal(item.candidateTrackId, trackB.id);
  assert.equal(item.confidence, 0.7);
  assert.equal(item.reason, "fuzzy_title");
  assert.equal(item.sources[0].sourceId, VID_A);
  assert.equal(item.candidateSources[0].sourceId, VID_B);
});

test("merge preview lists every moved item without writing", async (t) => {
  const { library, trackA, trackB } = await fixture(t);
  seedPair(library, trackA, trackB);
  library.addTag(trackB.id, "keep-me");

  const preview = mergeMusicTracks(library, { intoTrackId: trackA.id, fromTrackId: trackB.id });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.changes.trackDeleted, trackB.id);
  assert.equal(preview.changes.sourcesMoved[0].sourceId, VID_B);
  assert.deepEqual(preview.changes.tagsAdded, ["keep-me"]);
  assert.match(preview.impact, /deletes track/i);
  // Preview wrote nothing: both tracks and the pending pair remain.
  assert.ok(library.getTrackById(trackB.id));
  assert.equal(library.identityReviewQueue().length, 1);
});

test("merge apply folds from into to, and later matching sources respect the decision", async (t) => {
  const { library, trackA, trackB } = await fixture(t);
  seedPair(library, trackA, trackB);

  const applied = mergeMusicTracks(
    library,
    { intoTrackId: trackA.id, fromTrackId: trackB.id, mode: "apply" },
  );
  assert.equal(applied.mode, "apply");
  assert.equal(library.getTrackById(trackB.id), null);
  const sources = library.listTrackSources(trackA.id).map((s) => s.sourceId);
  assert.deepEqual(sources.sort(), [VID_A, VID_B].sort());
  // The removed track's canonical key is remembered as an alias: a new source
  // with the same canonical identity attaches to the merged track.
  const again = library.upsertTrack({
    title: "Song Beta",
    artist: "Artist B",
    source: { provider: "youtube", sourceId: VID_C },
  });
  assert.equal(again.track.id, trackA.id);
});

test("merge refuses self-merge and unknown ids", async (t) => {
  const { library, trackA } = await fixture(t);
  assert.throws(
    () => mergeMusicTracks(library, { intoTrackId: trackA.id, fromTrackId: trackA.id }),
    /itself/,
  );
  assert.throws(
    () => mergeMusicTracks(library, { intoTrackId: trackA.id, fromTrackId: 999 }),
    /Unknown trackId/,
  );
});

test("split preview validates ownership; apply moves exact sources into a locked track", async (t) => {
  const { library, trackA } = await fixture(t);
  const extra = library.upsertTrack({
    title: "Song Alpha (Live)",
    artist: "Artist A",
    source: { provider: "youtube", sourceId: VID_C },
  });
  // Force-attach the live source onto trackA to simulate a bad auto-merge.
  const liveSourceId = library.listTrackSources(extra.track.id)[0].id;
  library.mergeTracks(trackA.id, extra.track.id);

  const sources = library.listTrackSources(trackA.id);
  assert.equal(sources.length, 2);

  assert.throws(
    () => splitMusicTrack(library, { trackId: trackA.id, sourceIds: [999] }),
    /not on this track/,
  );

  const preview = splitMusicTrack(library, {
    trackId: trackA.id,
    sourceIds: [liveSourceId],
    fields: { title: "Song Alpha (Live)" },
  });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.movingSources[0].sourceId, VID_C);
  assert.equal(preview.remainingSources[0].sourceId, VID_A);
  assert.equal(preview.newTrack.identityLocked, true);
  assert.equal(library.listTrackSources(trackA.id).length, 2); // no write

  const applied = splitMusicTrack(library, {
    trackId: trackA.id,
    sourceIds: [liveSourceId],
    fields: { title: "Song Alpha (Live)" },
    mode: "apply",
  });
  assert.equal(applied.mode, "apply");
  assert.deepEqual(applied.movedSourceIds, [liveSourceId]);
  assert.equal(applied.newTrack.identityLocked, true);
  assert.equal(applied.originalTrack.sources[0].sourceId, VID_A);
});

test("resolve dismisses a pair and clears needs_review; lock blocks silent re-merge", async (t) => {
  const { library, trackA, trackB } = await fixture(t);
  seedPair(library, trackA, trackB);

  const preview = resolveIdentityReview(library, {
    trackId: trackA.id,
    candidateTrackId: trackB.id,
    decision: "distinct",
  });
  assert.equal(preview.mode, "preview");
  assert.equal(preview.pairPending, true);
  assert.equal(library.identityReviewQueue().length, 1); // no write

  const applied = resolveIdentityReview(library, {
    trackId: trackA.id,
    candidateTrackId: trackB.id,
    decision: "distinct",
    lock: true,
    mode: "apply",
  });
  assert.equal(applied.mode, "apply");
  assert.equal(library.identityReviewQueue().length, 0);
  assert.equal(library.getTrackById(trackA.id).needsReview, false);
  assert.equal(library.getTrackById(trackA.id).identityLocked, true);
  assert.equal(library.getTrackById(trackB.id).identityLocked, true);
});

test("set_identity_lock toggles the flag and reports before/after", async (t) => {
  const { library, trackA } = await fixture(t);
  const locked = setIdentityLock(library, { trackId: trackA.id, locked: true });
  assert.equal(locked.before, false);
  assert.equal(locked.after, true);
  const unlocked = setIdentityLock(library, { trackId: trackA.id, locked: false });
  assert.equal(unlocked.after, false);
});

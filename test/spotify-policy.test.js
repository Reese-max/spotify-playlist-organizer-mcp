import assert from "node:assert/strict";
import test from "node:test";
import manifest from "../policy/spotify-content-boundary.v1.json" with { type: "json" };
import {
  assertSpotifyToolExposureAllowed,
  getSpotifyToolExposureDecision,
} from "../src/provider-data-policy.js";

const spotifyTools = [
  "spotify_search_tracks",
  "spotify_identify_track",
  "spotify_resolve_links",
  "spotify_check_playlist_duplicates",
  "spotify_classify_playlist",
  "spotify_organize_playlist",
];

test("versioned Spotify boundary manifest classifies every registered Spotify tool fail-closed", () => {
  assert.equal(manifest.schema_version, 1);
  assert.equal(manifest.manifest_version, "1.0.0");
  assert.equal(manifest.model_visibility, "UNKNOWN");
  assert.equal(manifest.default_action, "BLOCK");
  assert.deepEqual(Object.keys(manifest.tools).sort(), spotifyTools.sort());

  for (const [toolName, route] of Object.entries(manifest.tools)) {
    assert.ok(route.output_fields.length > 0, toolName + " must enumerate its output fields");
    for (const fieldId of route.output_fields) {
      assert.ok(manifest.fields[fieldId], toolName + " references classified field " + fieldId);
      assert.equal(manifest.fields[fieldId].model_visibility, "UNKNOWN");
    }
    assert.equal(getSpotifyToolExposureDecision(toolName), "UNKNOWN");
    assert.throws(
      () => assertSpotifyToolExposureAllowed(toolName),
      (error) => error.code === "SPOTIFY_CONTENT_VISIBILITY_UNKNOWN",
    );
  }
});

test("Spotify boundary rejects unregistered routes and blocked fields", () => {
  assert.equal(getSpotifyToolExposureDecision("spotify_unreviewed_tool"), "UNKNOWN");
  assert.throws(
    () => assertSpotifyToolExposureAllowed("spotify_unreviewed_tool"),
    (error) => error.code === "SPOTIFY_CONTENT_VISIBILITY_UNKNOWN",
  );

  const blocked = structuredClone(manifest);
  const route = blocked.tools.spotify_search_tracks;
  blocked.model_visibility = "ALLOWED";
  for (const fieldId of route.output_fields) blocked.fields[fieldId].model_visibility = "ALLOWED";
  blocked.fields[route.output_fields[0]].model_visibility = "BLOCKED";
  assert.equal(getSpotifyToolExposureDecision("spotify_search_tracks", blocked), "BLOCKED");
  assert.throws(
    () => assertSpotifyToolExposureAllowed("spotify_search_tracks", blocked),
    (error) => error.code === "SPOTIFY_CONTENT_POLICY_BLOCKED",
  );
});

test("Spotify boundary allows only a fully reviewed synthetic route", () => {
  const reviewed = structuredClone(manifest);
  reviewed.model_visibility = "ALLOWED";
  reviewed.tools.spotify_search_tracks.model_visibility = "ALLOWED";
  for (const fieldId of reviewed.tools.spotify_search_tracks.output_fields) {
    reviewed.fields[fieldId].model_visibility = "ALLOWED";
  }
  assert.equal(getSpotifyToolExposureDecision("spotify_search_tracks", reviewed), "ALLOWED");
  assert.doesNotThrow(() => assertSpotifyToolExposureAllowed("spotify_search_tracks", reviewed));
  assert.equal(getSpotifyToolExposureDecision("spotify_organize_playlist", reviewed), "UNKNOWN");

  reviewed.schema_version = 2;
  assert.equal(getSpotifyToolExposureDecision("spotify_search_tracks", reviewed), "UNKNOWN");
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  DIMENSIONS,
  TAXONOMY,
  TAXONOMY_VERSION,
  canonicalValue,
  collapseText,
  isOfficialValue,
  scanTags,
  scanText,
} from "../src/taxonomy.js";

test("taxonomy is versioned and declares all eight dimensions", () => {
  assert.ok(Number.isInteger(TAXONOMY_VERSION) && TAXONOMY_VERSION >= 1);
  assert.deepEqual(DIMENSIONS, [
    "genre", "mood", "language", "activity", "energy", "era", "artist", "custom_tags",
  ]);
});

test("every synonym resolves to an official value of its dimension", () => {
  for (const dimension of DIMENSIONS) {
    const spec = TAXONOMY[dimension];
    for (const [value, synonyms] of Object.entries(spec.synonyms ?? {})) {
      assert.ok(spec.values.includes(value), `${dimension}.${value} must be official`);
      for (const synonym of synonyms) {
        assert.equal(
          canonicalValue(dimension, synonym),
          value,
          `${dimension} synonym "${synonym}" should map to "${value}"`,
        );
      }
    }
  }
});

test("every official value canonicalizes to itself", () => {
  for (const dimension of DIMENSIONS) {
    const spec = TAXONOMY[dimension];
    if (spec.open) continue;
    for (const value of spec.values) {
      assert.equal(canonicalValue(dimension, value), value);
      assert.ok(isOfficialValue(dimension, value));
    }
  }
});

test("synonym normalization collapses case, spaces, and hyphens", () => {
  for (const variant of ["jpop", "J-Pop", "J-POP", "j pop", "j-pop", "Japanese Pop"]) {
    assert.equal(canonicalValue("genre", variant), "j-pop", `"${variant}" should be j-pop`);
  }
  for (const variant of ["kpop", "K-Pop", "K-POP", "korean pop"]) {
    assert.equal(canonicalValue("genre", variant), "k-pop", `"${variant}" should be k-pop`);
  }
  assert.equal(canonicalValue("genre", "Hip Hop"), "hip-hop");
  assert.equal(canonicalValue("genre", "LOFI"), "lo-fi");
  assert.equal(canonicalValue("language", "Japanese"), "ja");
  assert.equal(canonicalValue("era", "90s"), "1990s");
});

test("unknown values are not official values", () => {
  assert.equal(canonicalValue("genre", "hyperpop"), null);
  assert.equal(canonicalValue("mood", "sultry"), null);
  assert.equal(isOfficialValue("genre", "hyperpop"), false);
  // Open dimensions keep the trimmed original instead of rejecting.
  assert.equal(canonicalValue("artist", "YOASOBI"), "YOASOBI");
  assert.equal(canonicalValue("custom_tags", "Hyperpop"), "Hyperpop");
  assert.equal(canonicalValue("genre", "   "), null);
});

test("scanText finds multiple dimension hits in one string", () => {
  const hits = scanText("Best J-POP workout anthem of the 90s");
  const pairs = hits.map((hit) => `${hit.dimension}:${hit.value}`);
  assert.ok(pairs.includes("genre:j-pop"));
  assert.ok(pairs.includes("activity:workout"));
  assert.ok(pairs.includes("era:1990s"));
});

test("scanText does not match inside other words", () => {
  const hits = scanText("popcorn gearbox workout").map((hit) => `${hit.dimension}:${hit.value}`);
  assert.equal(hits.includes("genre:pop"), false, '"popcorn" must not tag genre pop');
  assert.equal(hits.includes("genre:r&b"), false, '"gearbox" must not tag genre r&b');
  assert.ok(hits.includes("activity:workout"));
});

test("scanTags finds free-form tag keywords", () => {
  assert.deepEqual(scanTags("Idol (vocaloid cover) - slowed remix"), ["vocaloid", "cover", "remix", "slowed"]);
  assert.deepEqual(scanTags("plain title"), []);
});

test("collapseText is the shared lookup normalizer", () => {
  assert.equal(collapseText("J-Pop"), "jpop");
  assert.equal(collapseText("r & b"), "rb");
  assert.equal(collapseText(""), "");
});

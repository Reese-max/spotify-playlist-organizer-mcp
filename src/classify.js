import * as z from "zod/v4";
import { DEFAULT_RULES } from "./core.js";
import {
  DIMENSIONS,
  TAG_KEYWORDS,
  TAXONOMY,
  TAXONOMY_VERSION,
  canonicalValue,
  collapseText,
  normalizeText,
  scanTags,
  scanText,
} from "./taxonomy.js";

export const CLASSIFICATION_SOURCES = Object.freeze(["user", "rule", "model"]);
export const CLASSIFICATION_SYNC_PREFIX = "classification.";

// Dimensions that map 1:1 onto columns of the library `tracks` table.
const TRACK_FIELD_DIMENSIONS = Object.freeze([
  "genre", "mood", "language", "activity", "energy", "era", "artist",
]);

// Where a keyword was found decides how much we trust the deterministic match.
// Provider metadata (artist/channelTitle) is evidence, not ground truth.
const FIELD_CONFIDENCE = Object.freeze({
  title: 0.85,
  artist: 0.75,
  channelTitle: 0.6,
  description: 0.5,
});

const RULE_CATEGORY_CONFIDENCE = 0.5;
const RULE_TAG_CONFIDENCE = 0.5;
const MODEL_DEFAULT_CONFIDENCE = 0.7;

// DEFAULT_RULES categories carry over as dimension hints, keeping the old
// deterministic keyword rules useful as the no-model baseline.
const CATEGORY_HINTS = Object.freeze({
  focus: { activity: "focus", energy: "low", mood: "calm" },
  workout: { activity: "workout", energy: "high", mood: "energetic" },
  chill: { mood: "chill", energy: "low", activity: "relax" },
  party: { activity: "party", energy: "high", mood: "happy" },
});

// Cross-dimension inference: a genre match weakly implies a language.
const GENRE_LANGUAGE_HINTS = Object.freeze({
  "j-pop": "ja",
  "city-pop": "ja",
  "enka": "ja",
  "k-pop": "ko",
  "c-pop": "zh",
  "latin": "es",
  "reggaeton": "es",
});

export function classificationSyncKey(trackId) {
  return `${CLASSIFICATION_SYNC_PREFIX}${trackId}`;
}

function entrySchema(dimension) {
  const spec = TAXONOMY[dimension];
  return z.object({
    value: spec.open ? z.string().min(1).max(500) : z.enum([...spec.values]),
    source: z.enum(CLASSIFICATION_SOURCES),
    confidence: z.number().min(0).max(1),
    evidence: z.object({
      field: z.string().optional(),
      keyword: z.string().optional(),
      note: z.string().optional(),
    }).optional(),
    needsReview: z.boolean().optional(),
  });
}

export const classificationResultSchema = z.object({
  taxonomyVersion: z.literal(TAXONOMY_VERSION),
  dimensions: z.object(
    Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, z.array(entrySchema(dimension))])),
  ),
  provenance: z.object(
    Object.fromEntries(DIMENSIONS.map((dimension) => [
      dimension,
      z.enum(CLASSIFICATION_SOURCES).nullable(),
    ])),
  ),
  needsReview: z.array(z.object({
    dimension: z.enum(DIMENSIONS),
    value: z.string(),
    source: z.enum(CLASSIFICATION_SOURCES),
    reason: z.string(),
  })),
});

export function validateClassification(result) {
  return classificationResultSchema.parse(result);
}

function emptyDimensions() {
  return Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, []]));
}

function dedupeEntries(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = collapseText(entry.value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sortByConfidence(entries) {
  // Array.prototype.sort is stable: equal-confidence entries keep input order.
  return [...entries].sort((a, b) => b.confidence - a.confidence);
}

function capCardinality(dimension, entries) {
  const sorted = sortByConfidence(dedupeEntries(entries));
  return TAXONOMY[dimension].cardinality === "one" ? sorted.slice(0, 1) : sorted;
}

function computeProvenance(dimensions) {
  return Object.fromEntries(
    DIMENSIONS.map((dimension) => [dimension, dimensions[dimension][0]?.source ?? null]),
  );
}

function categoryMatches(text, rules) {
  const haystack = normalizeText(text);
  const source = rules && typeof rules === "object" ? rules : DEFAULT_RULES;
  const matched = [];
  for (const [category, keywords] of Object.entries(source)) {
    if (!category?.trim() || normalizeText(category) === "other" || !Array.isArray(keywords)) continue;
    if (keywords.some((keyword) => {
      const needle = normalizeText(keyword);
      return needle && haystack.includes(needle);
    })) {
      matched.push(category.trim());
    }
  }
  return matched;
}

function detectScriptLanguage(text) {
  // Hangul syllables + jamo, then hiragana/katakana, then CJK ideographs.
  if (/[가-힯ᄀ-ᅟ㄰-㆏]/.test(text)) return { value: "ko", confidence: 0.7 };
  if (/[぀-ゟ゠-ヿ]/.test(text)) return { value: "ja", confidence: 0.7 };
  if (/[㐀-䶿一-鿿]/.test(text)) return { value: "zh", confidence: 0.6 };
  return null;
}

function detectEraFromYear(text) {
  const match = String(text ?? "").match(/(?<!\d)(19[5-9]\d|20[0-2]\d)(?!\d)/);
  if (!match) return null;
  return { value: `${Math.floor(Number(match[1]) / 10) * 10}s`, year: match[1] };
}

function collectRuleDimensions(fields, rules) {
  const found = emptyDimensions();
  const add = (dimension, value, confidence, evidence) => {
    found[dimension].push({ value, source: "rule", confidence, evidence });
  };

  for (const [field, text] of Object.entries(fields)) {
    if (!text.trim()) continue;
    for (const hit of scanText(text)) {
      add(hit.dimension, hit.value, FIELD_CONFIDENCE[field], { field, keyword: hit.keyword });
    }
  }

  const combined = [fields.title, fields.artist, fields.channelTitle, fields.description]
    .filter(Boolean).join(" ");
  for (const category of categoryMatches(combined, rules)) {
    const hints = CATEGORY_HINTS[category.toLowerCase()];
    if (!hints) {
      add("custom_tags", category, 0.4, { note: `rule_category:${category}` });
      continue;
    }
    for (const [dimension, value] of Object.entries(hints)) {
      add(dimension, value, RULE_CATEGORY_CONFIDENCE, { note: `rule_category:${category}` });
    }
  }

  const scriptLanguage = detectScriptLanguage(`${fields.title} ${fields.artist}`);
  if (scriptLanguage) {
    add("language", scriptLanguage.value, scriptLanguage.confidence, {
      field: "title", note: "script_detection",
    });
  }

  const titleEra = detectEraFromYear(fields.title);
  const eraHit = titleEra ?? detectEraFromYear(fields.description);
  if (eraHit) {
    add("era", eraHit.value, titleEra ? 0.65 : 0.5, { note: `year:${eraHit.year}` });
  }

  for (const genreEntry of dedupeEntries(found.genre)) {
    const language = GENRE_LANGUAGE_HINTS[genreEntry.value];
    if (language) {
      add("language", language, 0.5, { note: `genre_hint:${genreEntry.value}` });
      break;
    }
  }

  if (fields.artist.trim()) {
    add("artist", fields.artist.trim(), 0.8, { field: "artist", note: "provider_metadata" });
  } else if (fields.channelTitle.trim()) {
    add("artist", fields.channelTitle.trim(), 0.55, {
      field: "channelTitle", note: "provider_metadata",
    });
  }

  for (const field of ["title", "description"]) {
    for (const tag of scanTags(fields[field])) {
      add("custom_tags", tag, RULE_TAG_CONFIDENCE, { field, keyword: tag });
    }
  }

  return found;
}

function clampConfidence(value, fallback) {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : fallback;
}

// Apply explicitly supplied labels (user or model). Values that do not resolve
// to the official taxonomy are diverted to custom_tags + needsReview instead of
// polluting a closed dimension.
function applyExplicit(target, review, classification, source, defaultConfidence) {
  if (!classification || typeof classification !== "object") return;
  const dimensions = classification.dimensions && typeof classification.dimensions === "object"
    ? classification.dimensions
    : classification;

  for (const dimension of DIMENSIONS) {
    const raw = dimensions[dimension];
    if (raw === undefined || raw === null) continue;
    const items = Array.isArray(raw) ? raw : [raw];
    for (const item of items) {
      const rawValue = typeof item === "object" && item !== null ? item.value : item;
      const confidence = source === "user"
        ? 1
        : clampConfidence(
          typeof item === "object" && item !== null ? item.confidence : undefined,
          defaultConfidence,
        );
      const canonical = canonicalValue(dimension, rawValue);
      if (canonical === null) {
        const text = String(rawValue ?? "").trim();
        if (text) {
          review.push({ dimension, value: text, source, reason: "unknown_taxonomy_value" });
          target.custom_tags.push({
            value: text, source, confidence, needsReview: true,
          });
        }
        continue;
      }
      target[dimension].push({ value: canonical, source, confidence });
    }
  }
}

function assembleDimensions({ rule, model, user }) {
  const dimensions = {};
  for (const dimension of DIMENSIONS) {
    if (dimension === "custom_tags") {
      // Tags accumulate: keep every source, deduplicated by normalized value.
      dimensions[dimension] = dedupeEntries([
        ...user[dimension], ...model[dimension], ...rule[dimension],
      ]);
      continue;
    }
    const picked = user[dimension].length
      ? user[dimension]
      : model[dimension].length
        ? model[dimension]
        : rule[dimension];
    dimensions[dimension] = capCardinality(dimension, picked);
  }
  return dimensions;
}

function dedupeReview(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.dimension}:${collapseText(entry.value)}:${entry.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Classify a track into the fixed multi-dimensional taxonomy.
//
//   classifyMusic({ title, artist, channelTitle, description, userClassification, rules, model })
//   -> { taxonomyVersion, dimensions, provenance, needsReview }
//
// `userClassification` fields always win; `model` (an optional local stub
// function, never an external API) fills dimensions the user left empty;
// deterministic rules fill the rest. If the model throws or returns unusable
// output the rule baseline still applies.
export async function classifyMusic(input = {}) {
  const {
    title = "",
    artist,
    channelTitle,
    description,
    userClassification,
    rules = DEFAULT_RULES,
    model,
  } = input ?? {};

  const fields = {
    title: String(title ?? ""),
    artist: artist == null ? "" : String(artist),
    channelTitle: channelTitle == null ? "" : String(channelTitle),
    description: description == null ? "" : String(description),
  };

  const rule = collectRuleDimensions(fields, rules);

  const modelDimensions = emptyDimensions();
  const modelReview = [];
  if (typeof model === "function") {
    try {
      const output = await model({ ...fields });
      applyExplicit(modelDimensions, modelReview, output, "model", MODEL_DEFAULT_CONFIDENCE);
    } catch {
      // Model unavailable or failed: the deterministic baseline still applies.
    }
  }

  const user = emptyDimensions();
  const userReview = [];
  applyExplicit(user, userReview, userClassification, "user", 1);

  const result = {
    taxonomyVersion: TAXONOMY_VERSION,
    dimensions: assembleDimensions({ rule, model: modelDimensions, user }),
    provenance: null,
    needsReview: dedupeReview([...userReview, ...modelReview]),
  };
  result.provenance = computeProvenance(result.dimensions);
  // Self-check: a bug in the pipeline must fail loudly instead of emitting
  // values outside the official taxonomy.
  return validateClassification(result);
}

// Merge a previously stored classification record with a fresh result.
// User-set values are never overwritten by later automatic classification;
// dimensions without user values are recomputed from `next`.
export function mergeClassification(prior, next) {
  if (!prior || typeof prior !== "object" || !prior.dimensions) return next;

  const dimensions = {};
  const needsReview = [...(prior.needsReview ?? []), ...(next.needsReview ?? [])];
  const carriedTags = [];

  for (const dimension of DIMENSIONS) {
    const priorUsers = [];
    for (const entry of prior.dimensions[dimension] ?? []) {
      if (entry?.source !== "user") continue;
      const canonical = canonicalValue(dimension, entry.value);
      if (canonical === null) {
        // Value was official under an older taxonomy: divert it now.
        needsReview.push({
          dimension, value: String(entry.value), source: "user", reason: "unknown_taxonomy_value",
        });
        carriedTags.push({
          value: String(entry.value), source: "user", confidence: 1, needsReview: true,
        });
        continue;
      }
      priorUsers.push({ ...entry, value: canonical });
    }

    const nextUsers = (next.dimensions[dimension] ?? []).filter((entry) => entry.source === "user");
    if (dimension === "custom_tags") {
      dimensions[dimension] = dedupeEntries([
        ...priorUsers, ...carriedTags, ...(next.dimensions[dimension] ?? []),
      ]);
    } else if (priorUsers.length || nextUsers.length) {
      // Latest user input wins ordering on single-value dimensions.
      dimensions[dimension] = capCardinality(dimension, [...nextUsers, ...priorUsers]);
    } else {
      dimensions[dimension] = next.dimensions[dimension] ?? [];
    }
  }

  const merged = {
    taxonomyVersion: TAXONOMY_VERSION,
    dimensions,
    provenance: computeProvenance(dimensions),
    needsReview: dedupeReview(needsReview),
  };
  return merged;
}

// Map a classification result onto `upsertTrack` fields. Only non-empty
// dimensions appear, so absent dimensions never clear stored values.
export function classificationToTrackFields(result) {
  const fields = {};
  for (const dimension of TRACK_FIELD_DIMENSIONS) {
    const entry = result?.dimensions?.[dimension]?.[0];
    if (entry?.value) fields[dimension] = entry.value;
  }
  return fields;
}

function readStoredClassification(library, trackId) {
  const raw = library.getSyncState(classificationSyncKey(trackId));
  if (typeof raw !== "string" || !raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Persist a classification through the public MusicLibrary API only:
// dimension fields via upsertTrack, custom tags via addTag, and the full
// provenance record via setSyncState under `classification.<trackId>`.
// Dimensions previously set by the user are preserved on reclassification.
export function persistClassification(library, trackInput, classification) {
  const { title, artist, source, playlist } = trackInput ?? {};
  if (!source?.provider || !source?.sourceId) {
    throw new Error("trackInput.source.provider and trackInput.source.sourceId are required.");
  }
  const priorTrack = library.getTrackBySource(source.provider, source.sourceId);
  const prior = priorTrack ? readStoredClassification(library, priorTrack.id) : null;
  const merged = mergeClassification(prior, classification);

  const fields = classificationToTrackFields(merged);
  const saved = library.upsertTrack({
    title,
    artist: fields.artist ?? artist,
    ...fields,
    source,
    ...(playlist ? { playlist } : {}),
  });
  const trackId = saved.track.id;

  for (const tag of merged.dimensions.custom_tags) {
    library.addTag(trackId, tag.value);
  }

  library.setSyncState(classificationSyncKey(trackId), {
    taxonomyVersion: merged.taxonomyVersion,
    dimensions: merged.dimensions,
    provenance: merged.provenance,
    needsReview: merged.needsReview,
  });

  const preserved = DIMENSIONS.filter(
    (dimension) => prior?.provenance?.[dimension] === "user"
      && merged.provenance[dimension] === "user",
  );
  return {
    track: saved.track,
    trackId,
    classification: merged,
    preserved,
    identity: saved.identity,
  };
}

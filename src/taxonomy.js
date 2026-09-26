// Fixed multi-dimensional music taxonomy. Versioned so classification records
// stored in the local library can be re-interpreted when official values change.

export const TAXONOMY_VERSION = 1;

export const DIMENSIONS = Object.freeze([
  "genre",
  "mood",
  "language",
  "activity",
  "energy",
  "era",
  "artist",
  "custom_tags",
]);

// Closed dimensions only accept the official `values` list below; anything else
// is diverted to `custom_tags` / `needsReview` instead of inventing new values.
// Open dimensions (`artist`, `custom_tags`) accept any non-empty string.
export const TAXONOMY = Object.freeze({
  genre: {
    cardinality: "many",
    open: false,
    values: [
      "pop", "j-pop", "k-pop", "c-pop", "city-pop",
      "rock", "indie", "punk", "metal",
      "hip-hop", "r&b", "soul", "funk",
      "jazz", "blues", "classical",
      "edm", "house", "techno", "trance", "dubstep",
      "lo-fi", "ambient", "folk", "country",
      "latin", "reggae", "reggaeton",
      "anime", "soundtrack", "synthwave", "disco", "gospel", "enka",
    ],
    synonyms: {
      "j-pop": ["jpop", "j pop", "japanese pop"],
      "k-pop": ["kpop", "k pop", "korean pop"],
      "c-pop": ["cpop", "c pop", "chinese pop", "mandopop", "cantopop"],
      "city-pop": ["city pop", "citypop"],
      "hip-hop": ["hiphop", "hip hop", "rap"],
      "r&b": ["rnb", "r & b", "r and b", "rhythm and blues", "rhythm & blues"],
      "metal": ["heavy metal"],
      "edm": ["electronic dance music", "electronica", "electronic"],
      "house": ["house music", "deep house", "tech house"],
      "lo-fi": ["lofi", "lo fi", "low fidelity", "lowfi"],
      "anime": ["anison", "anisong", "anime song"],
      "soundtrack": ["ost", "original soundtrack", "film score"],
      "synthwave": ["retrowave"],
      "latin": ["bossa nova", "bossanova", "musica latina"],
      "indie": ["indie pop", "indie rock"],
      "classical": ["orchestral", "orchestra", "symphony"],
      "country": ["country music"],
      "folk": ["folk music"],
      "reggaeton": ["regueton"],
    },
  },
  mood: {
    cardinality: "many",
    open: false,
    values: [
      "happy", "sad", "energetic", "calm", "chill",
      "melancholy", "romantic", "angry", "dark", "dreamy",
      "nostalgic", "uplifting", "mellow",
    ],
    synonyms: {
      "happy": ["cheerful", "joyful", "upbeat", "feel good", "feelgood"],
      "sad": ["heartbreak", "heartbreaking", "sadness", "tearjerker"],
      "energetic": ["hype", "pumped", "pumping", "high energy"],
      "calm": ["peaceful", "soothing", "serene", "tranquil"],
      "chill": ["chilled", "chillout", "chill out", "laid back", "laidback"],
      "melancholy": ["melancholic", "bittersweet", "wistful"],
      "romantic": ["romance", "love song", "love songs", "valentine"],
      "angry": ["rage", "furious"],
      "dark": ["gloomy", "eerie", "haunting", "moody"],
      "dreamy": ["dreamlike", "ethereal", "hazy"],
      "nostalgic": ["nostalgia", "throwback"],
      "uplifting": ["inspirational", "inspiring", "anthemic", "motivational"],
      "mellow": ["gentle"],
    },
  },
  language: {
    cardinality: "one",
    open: false,
    values: [
      "en", "ja", "ko", "zh", "es", "fr", "de", "it", "pt",
      "th", "vi", "id", "hi", "instrumental",
    ],
    synonyms: {
      "en": ["english"],
      "ja": ["japanese", "nihongo"],
      "ko": ["korean"],
      "zh": ["chinese", "mandarin", "cantonese", "taiwanese", "putonghua"],
      "es": ["spanish", "espanol"],
      "fr": ["french", "francais"],
      "de": ["german", "deutsch"],
      "it": ["italian"],
      "pt": ["portuguese", "portugues"],
      "th": ["thai"],
      "vi": ["vietnamese"],
      "id": ["indonesian", "bahasa"],
      "hi": ["hindi"],
      "instrumental": ["no vocals", "wordless"],
    },
  },
  activity: {
    cardinality: "many",
    open: false,
    values: [
      "focus", "study", "workout", "running", "party", "sleep",
      "relax", "commute", "driving", "cooking", "gaming", "cleaning",
    ],
    synonyms: {
      "focus": ["concentration", "deep work"],
      "study": ["studying", "homework", "revision", "exam"],
      "workout": ["gym", "training", "exercise", "fitness"],
      "running": ["jog", "jogging", "marathon"],
      "party": ["celebration", "fiesta"],
      "sleep": ["sleeping", "bedtime", "lullaby", "insomnia"],
      "relax": ["relaxing", "unwind", "spa"],
      "commute": ["commuting"],
      "driving": ["drive", "road trip", "roadtrip", "highway"],
      "cooking": ["kitchen", "baking"],
      "gaming": ["gamer", "esports", "video game"],
      "cleaning": ["chores", "tidy up"],
    },
  },
  energy: {
    cardinality: "one",
    open: false,
    values: ["low", "medium", "high"],
    synonyms: {
      "low": ["low energy", "calm", "mellow", "soft", "slow", "downtempo", "ballad", "sleepy"],
      "medium": ["mid tempo", "midtempo", "moderate"],
      "high": ["high energy", "energetic", "intense", "hype", "banger", "bangers", "aggressive", "uptempo", "fast"],
    },
  },
  era: {
    cardinality: "one",
    open: false,
    values: ["1950s", "1960s", "1970s", "1980s", "1990s", "2000s", "2010s", "2020s"],
    synonyms: {
      "1950s": ["50s", "fifties", "1950's"],
      "1960s": ["60s", "sixties", "1960's"],
      "1970s": ["70s", "seventies", "1970's"],
      "1980s": ["80s", "eighties", "1980's"],
      "1990s": ["90s", "nineties", "1990's"],
      "2000s": ["00s", "noughties", "y2k"],
      "2010s": ["10s", "2010's"],
      "2020s": ["20s", "2020's"],
    },
  },
  artist: { cardinality: "one", open: true, values: [] },
  custom_tags: { cardinality: "many", open: true, values: [] },
});

// Free-text keywords that become rule-sourced custom tags instead of official
// dimension values. Keeps meaningful signals (vocaloid, cover, live) without
// expanding the official taxonomy.
export const TAG_KEYWORDS = Object.freeze([
  "vocaloid", "cover", "acoustic version", "acoustic", "live version", "live",
  "remix", "remastered", "remaster", "karaoke", "nightcore", "slowed",
  "sped up", "8d audio", "amv", "piano version", "singer-songwriter", "mv",
]);

export function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

// Lookup form: all separators removed so "J-Pop", "j pop" and "jpop" share a key.
export function collapseText(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, "");
}

// Scan form: separators become single spaces so word-boundary regexes work.
function scanForm(value) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, " ").trim();
}

const LOOKUP = new Map(); // dimension -> Map(collapsed synonym -> official value)
const SCANNERS = []; // { dimension, value, keyword, pattern }
const TAG_SCANNERS = []; // { keyword, pattern }

function keywordPattern(phrase) {
  const tokens = scanForm(phrase).split(" ").filter(Boolean);
  if (!tokens.length) return null;
  // Tokens are already [a-z0-9], so no escaping is needed. `[^a-z0-9]*` between
  // tokens matches "j-pop", "j pop" and "jpop" with one pattern.
  return new RegExp(`\\b${tokens.join("[^a-z0-9]*")}\\b`);
}

for (const dimension of DIMENSIONS) {
  const spec = TAXONOMY[dimension];
  const lookup = new Map();
  LOOKUP.set(dimension, lookup);
  if (spec.open) continue;
  for (const value of spec.values) {
    for (const phrase of [value, ...(spec.synonyms[value] ?? [])]) {
      const collapsed = collapseText(phrase);
      if (collapsed && !lookup.has(collapsed)) lookup.set(collapsed, value);
      const pattern = keywordPattern(phrase);
      if (pattern) SCANNERS.push({ dimension, value, keyword: phrase, pattern });
    }
  }
}

for (const keyword of TAG_KEYWORDS) {
  const pattern = keywordPattern(keyword);
  if (pattern) TAG_SCANNERS.push({ keyword, pattern });
}

export function isOpenDimension(dimension) {
  return TAXONOMY[dimension]?.open === true;
}

// Resolve a raw label to its official value. Closed dimensions return the
// canonical value or null; open dimensions return the trimmed original.
export function canonicalValue(dimension, raw) {
  const spec = TAXONOMY[dimension];
  if (!spec) return null;
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  if (spec.open) return trimmed;
  return LOOKUP.get(dimension).get(collapseText(trimmed)) ?? null;
}

export function isOfficialValue(dimension, value) {
  const spec = TAXONOMY[dimension];
  if (!spec) return false;
  if (spec.open) return typeof value === "string" && value.trim().length > 0;
  return spec.values.includes(value);
}

// Find every official taxonomy value mentioned in free text.
// Returns [{ dimension, value, keyword }] (deduplicated per value+keyword).
export function scanText(text) {
  const haystack = scanForm(text);
  if (!haystack) return [];
  const hits = [];
  for (const scanner of SCANNERS) {
    if (scanner.pattern.test(haystack)) {
      hits.push({ dimension: scanner.dimension, value: scanner.value, keyword: scanner.keyword });
    }
  }
  return hits;
}

// Find free-form tag keywords in text for the custom_tags dimension.
export function scanTags(text) {
  const haystack = scanForm(text);
  if (!haystack) return [];
  return TAG_SCANNERS.filter((scanner) => scanner.pattern.test(haystack))
    .map((scanner) => scanner.keyword);
}

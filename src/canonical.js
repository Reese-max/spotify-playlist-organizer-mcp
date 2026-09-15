// Latin/Greek/Cyrillic diacritics only; CJK combining marks (e.g. dakuten
// U+3099/U+309A) are phonemes, not decoration, and must survive normalization.
const COMBINING_MARK = /[\u0300-\u036F\u1AB0-\u1AFF\u1DC0-\u1DFF\u20D0-\u20FF]/gu;
const PUNCT_OR_SYMBOL = /[\p{P}\p{S}]/gu;
const WHITESPACE = /\s+/g;
const APOSTROPHE = /['ʼ`]/g;
const CJK_QUOTE_MARK = /[「」『』《》]/g;
const BRACKET_SEGMENT = /[\(\[\{【]([^()\[\]{}【】]*)[\)\]\}】]/g;
const FEATURE_TAIL = /(?:\s*[-–—:]\s*|\s+)(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;
const FEATURE_INNER = /^(?:feat\.?|ft\.?|featuring)\s+(.+)$/i;
const ARTIST_TITLE_SPLIT = /^\s*(.+?)\s*[-–—]\s*(.+?)\s*$/;
const TOPIC_SUFFIX = /\s*[-–—]\s*topic\s*$/i;
const FEATURE_SPLIT = /[,;&、×]|\s+and\s+/i;

export const SOURCE_TYPES = Object.freeze([
  "official_video",
  "official_audio",
  "live",
  "lyrics",
  "cover",
  "remix",
  "remaster",
  "unknown",
]);

export const VERSION_TYPES = Object.freeze([
  "live",
  "cover",
  "remix",
  "remaster",
  "acoustic",
  "instrumental",
  "karaoke",
  "demo",
  "spedup",
  "slowed",
]);

// Version qualifiers describe a different performance/recording of a song, so
// they are part of the canonical key: a "live" source must never silently merge
// into the studio track.
const VERSION_RULES = [
  { type: "live", re: /\blive\b|現場|ライブ|演唱會|音乐会/i },
  { type: "cover", re: /\bcover(?:ed|s|ing)?\b|翻唱|カバー/i },
  { type: "remix", re: /\b(?:remix(?:es|ed|ing)?|re-?mix|rmx|club\s+mix|extended\s+mix)\b|混音|リミックス/i },
  { type: "remaster", re: /\bremaster(?:ed|ing|s)?\b|リマスター?|重製|重制/i },
  { type: "acoustic", re: /\bacoustic\b|\bunplugged\b|アコースティック|不插電/i },
  { type: "instrumental", re: /\binstrumental\b|インスト(?:ルメンタル)?/i },
  { type: "karaoke", re: /\bkaraoke\b|カラオケ|卡拉ok/i },
  { type: "demo", re: /\bdemo\b/i },
  { type: "spedup", re: /\bsped\s*up\b|\bnightcore\b/i },
  { type: "slowed", re: /\bslowed(?:\s*(?:\+|and)\s*reverb)?\b/i },
];

// Packaging qualifiers describe how the same recording is wrapped; they pick a
// source_type but never enter the canonical key, so an Official MV and an
// Official Audio of the same song still share one canonical track.
const PACKAGING_RULES = [
  { type: "lyrics", re: /\blyrics?\b|歌詞|リリック/i },
  { type: "official_audio", re: /\bofficial\s+audio\b|\baudio\b|音訊|オーディオ/i },
  {
    type: "official_video",
    re: /\bofficial\b|\bmv\b|\bm\/v\b|\bmusic\s+video\b|官方|ミュージックビデオ/i,
  },
];

const NEUTRAL_BRACKET = /^(?:hd|uhd|4k|8k|explicit|clean|deluxe(?:\s+edition)?|(?:\w+\s+)?edition|anniversary\s+edition|mono|stereo|visualizer|audio\s+only|full\s+version|version|video|color\s+coded|english\s+version|\d{4})$/i;

const TAIL_QUALIFIER = /(?:\s*[-–—|]\s*|\s+)(?:official\s+(?:music\s+)?video|official\s+audio|official\s+m\.?v\.?|music\s+video|lyrics?\s+video|lyrics?|audio|mv|m\/v|video|hd|4k|visualizer|explicit|clean)\s*$/i;

const TAIL_VERSION = /(?:\s*[-–—]\s+|\s+)(live(?:\s+version|\s+at\s+.+|\s+in\s+.+)?|cover(?:ed|s|ing)?|remix(?:es|ed|ing)?|remaster(?:ed|ing|s)?(?:\s+\d{4})?|acoustic|instrumental|karaoke|demo|unplugged|翻唱|カバー|ライブ|現場|演唱會|音乐会|リミックス|混音|リマスター?|重製|重制|不插電|アコースティック|カラオケ|卡拉ok)\s*$/i;

function asText(value) {
  return typeof value === "string" ? value : "";
}

export function normalizeText(value) {
  return asText(value)
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(COMBINING_MARK, "")
    .normalize("NFC")
    .replace(APOSTROPHE, "")
    .replace(CJK_QUOTE_MARK, " ")
    .replace(PUNCT_OR_SYMBOL, " ")
    .replace(WHITESPACE, " ")
    .trim();
}

export function normalizeArtist(value) {
  let text = asText(value).normalize("NFKC");
  text = text.replace(TOPIC_SUFFIX, "");
  const feature = text.match(FEATURE_INNER) || text.match(FEATURE_TAIL);
  if (feature) text = text.slice(0, feature.index);
  const normalized = normalizeText(text)
    .replace(/\s+and\s+/g, " ")
    .replace(/\s+x\s+/g, " ")
    .replace(WHITESPACE, " ")
    .replace(/^the\s+/, "")
    .trim();
  return normalized;
}

function splitFeatures(raw) {
  return raw
    .split(FEATURE_SPLIT)
    .map((part) => normalizeText(part))
    .filter(Boolean);
}

function versionQualifier(segment) {
  for (const rule of VERSION_RULES) {
    const match = segment.match(rule.re);
    if (!match) continue;
    const detail = normalizeText(
      segment.slice(0, match.index) + " " + segment.slice(match.index + match[0].length),
    );
    return { type: rule.type, detail };
  }
  return null;
}

function packagingType(text) {
  for (const rule of PACKAGING_RULES) {
    if (rule.re.test(text)) return rule.type;
  }
  return null;
}

function stripTailQualifiers(text, versions, packagings) {
  let working = text;
  for (let guard = 0; guard < 6; guard += 1) {
    const versionMatch = working.match(TAIL_VERSION);
    if (versionMatch && working.slice(0, versionMatch.index).trim()) {
      const version = versionQualifier(versionMatch[1]);
      if (version) versions.push(version);
      working = working.slice(0, versionMatch.index);
      continue;
    }
    const next = working.replace(TAIL_QUALIFIER, "");
    if (next === working || !next.trim()) return working;
    const stripped = working.slice(next.length);
    const packaging = packagingType(stripped);
    if (packaging) packagings.push(packaging);
    working = next;
  }
  return working;
}

export function canonicalizeSource(input = {}) {
  const rawTitle = asText(input.title);
  const rawArtist = asText(input.artist);
  const channelTitle = asText(input.channelTitle);
  const versionTypeHint = asText(input.versionType);
  const sourceTypeHint = asText(input.sourceType).toLowerCase();

  const features = [];
  const versions = [];
  const packagings = [];
  const leftovers = [];

  const withoutBrackets = rawTitle
    .normalize("NFKC")
    .replace(CJK_QUOTE_MARK, " ")
    .replace(BRACKET_SEGMENT, (_match, inner) => {
      const segment = inner.trim();
      if (!segment) return " ";
      const feature = segment.match(FEATURE_INNER);
      if (feature) {
        features.push(...splitFeatures(feature[1]));
        return " ";
      }
      const version = versionQualifier(segment);
      if (version) {
        versions.push(version);
        return " ";
      }
      const packaging = packagingType(segment);
      if (packaging) {
        packagings.push(packaging);
        return " ";
      }
      if (NEUTRAL_BRACKET.test(segment)) return " ";
      leftovers.push(segment);
      return " ";
    });

  let working = withoutBrackets;
  const inlineFeature = working.match(FEATURE_TAIL);
  if (inlineFeature) {
    features.push(...splitFeatures(inlineFeature[1]));
    working = working.slice(0, inlineFeature.index);
  }
  working = stripTailQualifiers(working, versions, packagings);

  let artist = rawArtist;
  if (!artist.trim()) {
    const split = working.match(ARTIST_TITLE_SPLIT);
    if (split && normalizeText(split[1]) && normalizeText(split[2])) {
      artist = split[1];
      working = split[2];
      working = stripTailQualifiers(working, versions, packagings);
    }
  } else {
    const embedded = working.match(ARTIST_TITLE_SPLIT);
    if (embedded && normalizeArtist(embedded[1]) === normalizeArtist(artist)) {
      working = embedded[2];
    }
  }
  if (leftovers.length) working = `${working.trim()} ${leftovers.join(" ")}`.trim();

  const artistFeature = artist.match(FEATURE_TAIL) || artist.match(FEATURE_INNER);
  if (artistFeature) {
    features.push(...splitFeatures(artistFeature[1]));
    artist = artist.slice(0, artistFeature.index);
  }

  const normalizedTitle = normalizeText(working) || normalizeText(rawTitle);
  const normalizedArtist = normalizeArtist(artist) || normalizeArtist(channelTitle);

  let version = versions.length
    ? (versions[0].detail ? `${versions[0].type}:${versions[0].detail}` : versions[0].type)
    : "";
  if (!version) {
    const fromSource = VERSION_TYPES.includes(sourceTypeHint) ? sourceTypeHint : "";
    const fromHint = normalizeText(versionTypeHint).replace(WHITESPACE, "_");
    version = fromSource || (VERSION_TYPES.includes(fromHint) ? fromHint : "");
  }

  let sourceType = SOURCE_TYPES.includes(sourceTypeHint) ? sourceTypeHint : null;
  if (!sourceType && versionTypeHint) {
    const hinted = normalizeText(versionTypeHint).replace(WHITESPACE, "_");
    if (SOURCE_TYPES.includes(hinted)) sourceType = hinted;
    else if (hinted === "mv" || hinted === "music_video") sourceType = "official_video";
    else if (hinted === "audio") sourceType = "official_audio";
  }
  if (!sourceType && versions.length && SOURCE_TYPES.includes(versions[0].type)) {
    sourceType = versions[0].type;
  }
  if (!sourceType) {
    const haystack = [rawTitle, ...leftovers].join(" ");
    for (const rule of PACKAGING_RULES) {
      if (rule.re.test(haystack)) {
        sourceType = rule.type;
        break;
      }
    }
    if (!sourceType && packagings.length) sourceType = packagings[0];
  }
  if (!sourceType && TOPIC_SUFFIX.test(channelTitle.normalize("NFKC"))) {
    sourceType = "official_audio";
  }
  if (!sourceType) sourceType = "unknown";

  return {
    baseTitle: working.trim() || rawTitle.trim(),
    normalizedTitle,
    artist: artist.trim() || null,
    normalizedArtist,
    features,
    version,
    sourceType,
    packaging: packagings,
    canonicalKey: `ct|${normalizedArtist}|${normalizedTitle}|${version}`,
  };
}

export function tokenSimilarity(a, b) {
  const left = new Set(normalizeText(a).split(" ").filter(Boolean));
  const right = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

export function tokenContainment(a, b) {
  const left = new Set(normalizeText(a).split(" ").filter(Boolean));
  const right = new Set(normalizeText(b).split(" ").filter(Boolean));
  if (!left.size || !right.size) return false;
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  for (const token of small) if (!large.has(token)) return false;
  return true;
}

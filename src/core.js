export const DEFAULT_RULES = {
  Focus: ["study", "focus", "classical", "instrumental", "piano", "ambient", "concentration"],
  Workout: ["workout", "gym", "running", "training", "edm", "energetic", "exercise"],
  Chill: ["chill", "lofi", "lo-fi", "acoustic", "relax", "relaxing", "jazz", "sleep"],
  Party: ["party", "dance", "club", "remix", "disco", "celebration", "pop"],
  Other: [],
};

const SPOTIFY_ID = /^[A-Za-z0-9]+$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"]);

export function parseLink(input) {
  if (typeof input !== "string" || !input.trim()) {
    throw new Error("A non-empty link or search query is required.");
  }

  const value = input.trim();
  const spotifyUri = value.match(/^spotify:(track|playlist):([A-Za-z0-9]+)$/i);
  if (spotifyUri) {
    return {
      kind: `spotify-${spotifyUri[1].toLowerCase()}`,
      id: spotifyUri[2],
      uri: value,
      url: `https://open.spotify.com/${spotifyUri[1].toLowerCase()}/${spotifyUri[2]}`,
    };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return { kind: "query", query: value };
  }

  const host = url.hostname.toLowerCase();
  if (host === "open.spotify.com") {
    const match = url.pathname.match(/\/(track|playlist)\/([A-Za-z0-9]+)/i);
    if (match) {
      return {
        kind: `spotify-${match[1].toLowerCase()}`,
        id: match[2],
        uri: `spotify:${match[1].toLowerCase()}:${match[2]}`,
        url: `https://open.spotify.com/${match[1].toLowerCase()}/${match[2]}`,
      };
    }
  }

  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    if (id) return { kind: "youtube-video", id, url: value };
  }

  if (YOUTUBE_HOSTS.has(host)) {
    const playlistId = url.searchParams.get("list");
    if (url.pathname === "/playlist" && playlistId) {
      return { kind: "youtube-playlist", id: playlistId, url: value };
    }

    const id = url.searchParams.get("v") || url.pathname.match(/\/(?:shorts|live)\/([^/]+)/i)?.[1];
    if (id) return { kind: "youtube-video", id, url: value };
  }

  return { kind: "query", query: value };
}

export function parsePlaylistId(input) {
  const parsed = parseLink(input);
  if (parsed.kind === "spotify-playlist") return parsed.id;
  if (SPOTIFY_ID.test(input.trim())) return input.trim();
  throw new Error("Expected a Spotify playlist URL, Spotify playlist URI, or playlist ID.");
}

export function unwrapTrack(item) {
  return item?.item ?? item?.track ?? item ?? null;
}

export function trackSummary(item, position) {
  const track = unwrapTrack(item);
  if (!track || typeof track !== "object") return { position, unavailable: true };

  const artists = Array.isArray(track.artists)
    ? track.artists.map((artist) => typeof artist === "string" ? artist : artist?.name).filter(Boolean)
    : [];
  const videoId = typeof track.id === "object"
    ? track.id?.videoId
    : track.contentDetails?.videoId ?? track.snippet?.resourceId?.videoId;
  const id = typeof track.id === "string" ? track.id : videoId ?? track.videoId ?? null;
  const isYouTube = Boolean(videoId || track.platform === "youtube" || track.snippet?.channelTitle);
  const album = track.album?.name ?? track.album?.title ?? null;
  const externalUrl = track.external_urls?.spotify
    ?? track.external_url
    ?? track.url
    ?? (isYouTube && id ? `https://www.youtube.com/watch?v=${id}` : id ? `https://open.spotify.com/track/${id}` : null);
  return {
    position,
    id,
    name: track.name ?? track.title ?? track.snippet?.title ?? "Unknown track",
    artists,
    album: album ?? null,
    uri: track.uri ?? (isYouTube && id ? `youtube:video:${id}` : id ? `spotify:track:${id}` : null),
    url: externalUrl,
    isLocal: Boolean(track.is_local),
    platform: track.platform ?? (isYouTube ? "youtube" : "spotify"),
    channel: track.channel ?? track.channelTitle ?? track.snippet?.channelTitle ?? null,
  };
}

function normalizeText(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .trim();
}

function trackSearchText(item) {
  const track = unwrapTrack(item);
  return normalizeText([
    track?.name,
    track?.title,
    track?.snippet?.title,
    track?.album?.name,
    track?.channel,
    track?.channelTitle,
    track?.snippet?.channelTitle,
    ...(track?.artists ?? []).map((artist) => typeof artist === "string" ? artist : artist?.name),
  ].filter(Boolean).join(" "));
}

function normalizedRules(rules) {
  const source = rules && typeof rules === "object" ? rules : DEFAULT_RULES;
  const entries = Object.entries(source)
    .filter(([category, keywords]) => category.trim() && Array.isArray(keywords))
    .map(([category, keywords]) => [category.trim(), keywords.map(normalizeText).filter(Boolean)]);
  if (!entries.some(([category]) => normalizeText(category) === "other")) entries.push(["Other", []]);
  return entries;
}

export function classifyTrack(item, rules = DEFAULT_RULES) {
  const haystack = trackSearchText(item);
  for (const [category, keywords] of normalizedRules(rules)) {
    if (normalizeText(category) === "other") continue;
    if (keywords.some((keyword) => haystack.includes(keyword))) return category;
  }
  return normalizedRules(rules).find(([category]) => normalizeText(category) === "other")?.[0] ?? "Other";
}

export function classifyItems(items, rules = DEFAULT_RULES) {
  const categories = new Map();
  const assignments = items.map((item, index) => {
    const category = classifyTrack(item, rules);
    const summary = trackSummary(item, index + 1);
    if (!categories.has(category)) categories.set(category, []);
    categories.get(category).push(summary);
    return { category, ...summary };
  });

  return {
    totalItems: items.length,
    counts: Object.fromEntries([...categories].map(([category, tracks]) => [category, tracks.length])),
    categories: Object.fromEntries(categories),
    assignments,
  };
}

export function findDuplicates(items) {
  const groups = new Map();
  for (let index = 0; index < items.length; index += 1) {
    const summary = trackSummary(items[index], index + 1);
    const key = summary.id
      ? `id:${summary.id}`
      : `meta:${normalizeText(`${summary.name} ${summary.artists.join(" ")} ${summary.album ?? ""}`)}`;
    if (!key.slice(key.indexOf(":") + 1)) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(summary);
  }

  const duplicates = [...groups.values()].filter((occurrences) => occurrences.length > 1);
  return {
    totalItems: items.length,
    duplicateGroups: duplicates.length,
    duplicateItemCount: duplicates.reduce((total, occurrences) => total + occurrences.length - 1, 0),
    hasDuplicates: duplicates.length > 0,
    duplicates,
  };
}

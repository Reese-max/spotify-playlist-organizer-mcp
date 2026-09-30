import { appendFileSync } from "node:fs";

const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input?.url;
  if (/^https:\/\/(?:api|accounts)\.spotify\.com\//i.test(url ?? "")) {
    appendFileSync(process.env.SPOTIFY_FETCH_LOG, "Spotify network request attempted\n");
    throw new Error("Synthetic test denied a Spotify network request.");
  }
  return originalFetch(input, init);
};

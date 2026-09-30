# Spotify content and MCP result boundary

## Policy text checked

The [Spotify Developer Policy](https://developer.spotify.com/policy) states that developers must not analyze Spotify Content or the Spotify Service for purposes including derived listenership metrics, benchmarking, functionality, usage statistics, user metrics, and user profiles (III.13). It also says not to use the Spotify Platform or Spotify Content to train or otherwise ingest Spotify Content into an ML/AI model (III.14). Spotify Developer Terms version 10, effective 15 May 2025, repeats the ML/AI restriction (IV.2.1). The Terms define Spotify Content to include metadata and playlists (II.8), restrict storing, aggregating, compiling, or creating databases of Spotify Content except as strictly necessary to operate the application, and require displayed data to remain up to date (IV.3.1); local caching is separately limited (IV.3.2).

These are policy statements, not a legal conclusion about this application or a particular model client. The issue raised is whether returning Spotify fields from an MCP server to its client constitutes or leads to prohibited model ingestion. That interpretation is not resolved here.

## MCP boundary and conservative runtime behavior

The [MCP Tools specification](https://modelcontextprotocol.io/specification/2026-07-28/server/tools) describes tools as model-controlled and callable by language models, while allowing clients to expose tools through different interface patterns. It defines the tool result exchanged between server and client; it does not guarantee how every client routes or displays result text, or whether a specific client inserts it into model context.

The versioned [field classification manifest](../policy/spotify-content-boundary.v1.json) maps all six Spotify tools to their Spotify-derived result fields and marks model visibility `UNKNOWN`. The runtime therefore returns a fixed typed error before any Spotify handler executes. It also checks again before serializing a handler result, so a future manifest change must explicitly mark the global policy, route, and every returned field `ALLOWED`. Unknown or blocked fields remain denied. The gate has no environment-variable override.

This disables Spotify search, identify, link resolution, duplicate checking, classification, and organization through MCP until an approved client/data path is documented. The `spotify_organize_playlist` schema still defaults to `preview`; `apply` remains an explicit caller choice. Both modes are currently blocked before any provider access, so the guard cannot perform a playlist write.

The guard covers MCP result emission only. It does not assess whether other Spotify use is authorized, change provider terms, establish client-side behavior, or constitute legal approval. No Spotify credentials or API calls were used for this work. Regression tests use synthetic values and deny Spotify network requests.

## Evidence still needed

- Identify the supported MCP clients and verify, for each, whether tool results are sent to model context, shown only to users, or controlled by an explicit per-call approval/data-use setting.
- Review the exact proposed product/data flow with the relevant policy/legal owner before changing any `UNKNOWN` field to `ALLOWED`.
- If a client cannot guarantee result handling, keep Spotify result fields blocked or move the interaction to a separately reviewed user-only interface. Do not treat a playlist `preview` or explicit `apply` choice as model-visibility approval.


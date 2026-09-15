# Music Playlist Organizer MCP

這是一個以 Node.js 撰寫的 MCP Server，讓你把找到的歌曲名稱或 YouTube／YouTube Music 連結，辨識後分類、去重，並加入自己的 YouTube 播放清單，之後可以直接回到 YouTube 觀看。

目前以 YouTube 為主要 provider；Spotify 工具仍保留，但屬於選配的 legacy provider。

## 收藏流程

建議的統一入口是 `save_music`：一次呼叫完成「辨識 → 綁定影片 → canonical 去重 → 分類 → 寫入本機音樂庫 →（可選）同步 YouTube 播放清單」，並回傳完整 receipt。

```text
save_music({
  "input": "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
  "mode": "apply"
})
```

- `input` 接受歌曲名稱、YouTube／YouTube Music 影片連結或 11 字元 video ID；`videoId` 可指定候選影片。
- `mode` 預設 `"preview"`（不寫入）；`"apply"` 才會實際寫入。
- `syncToYouTube` 預設 `true`；preview 模式仍會預覽 YouTube 步驟，設 `false` 可只寫本機音樂庫。
- `tags`／`category` 會成為使用者標籤（只增不覆寫既有使用者標籤）；`category` 同時決定目標播放清單名稱，`playlist` 可直接指定播放清單（名稱、URL 或 ID）。
- 精確連結或 video ID 走 fast path；自由文字無法唯一綁定時回傳 `selection_required` 與 `candidates`，**不會**默默收藏搜尋第一名——請用回傳的 `videoId` 重新呼叫。
- 本機音樂庫寫入與 YouTube 寫入是獨立步驟：一邊失敗時 receipt 會回報真實的 partial `writeState`（如 `UNKNOWN_AFTER_WRITE`、`PARTIAL_PLAYLIST_CREATED`）、`completedSteps` 與安全的 `nextStep`，不會把部分成功包成一般錯誤。重複收藏同一 `videoId` 是冪等的（`skipped_duplicate`）。

若使用底層工具，對「歌曲名稱或搜尋文字」仍可採用兩階段流程：

1. 呼叫 `youtube_identify_track`，取得候選影片與 `videoId`。
2. 使用者確認候選後，把選定的 `videoId` 傳給 `youtube_save_track`，並設定 `mode: "apply"`。
3. Server 依分類找到或建立播放清單，檢查相同 `videoId` 後才加入。

如果輸入本身是精確的 YouTube／YouTube Music 影片連結，可以直接套用；播放清單連結不能當成單一歌曲輸入。

## YouTube 工具

- `save_music`：**建議的收藏入口**。辨識、綁定、canonical 去重、多維度分類、寫入本機音樂庫並可選同步 YouTube 播放清單，回傳含 exact IDs、duplicate level、syncState 與 nextStep 的完整 receipt。

- `youtube_search_videos`：搜尋歌曲、藝人或影片。
- `youtube_identify_track`：從 URL、YouTube Music URL、影片 ID 或文字搜尋辨識影片。
- `youtube_resolve_links`：批次解析多個連結或搜尋文字。
- `youtube_list_playlists`：列出已授權帳號的播放清單。
- `youtube_create_playlist`：建立私人、未列出或公開播放清單。
- `youtube_check_playlist_duplicates`：檢查播放清單內的重複影片。
- `youtube_classify_playlist`：依標題與頻道關鍵字預覽分類。
- `youtube_add_to_playlist`：預覽或將影片加入既有播放清單。
- `youtube_save_track`：辨識、分類、去重，並加入指定或自動建立的分類播放清單。
- `youtube_auth_status`：查看憑證狀態，不會顯示 token。
- `youtube_auth_revoke`：撤銷 OAuth 憑證並刪除本機加密憑證檔。
- `library_status`：查看本機音樂庫路徑、schema version 與曲目數，不會回傳任何列內容或 secret。
- `classify_track`：用固定 taxonomy 預覽單曲的多維度分類（genre、mood、language、activity、energy、era、artist、custom_tags），每個值附來源（`user`／`rule`／`model`）與信心度；唯讀，不寫入音樂庫。

## 多維度分類

`src/classify.js` 的 `classifyMusic({ title, artist, channelTitle, description, userClassification })` 回傳 `{ taxonomyVersion, dimensions, provenance, needsReview }`：

- 固定 taxonomy 定義在 `src/taxonomy.js`（`TAXONOMY_VERSION = 1`）；同義詞會正規化（`jpop`／`J-Pop`／`J-POP` → `j-pop`）。
- 無法對應官方值的輸入會導向 `custom_tags` 並列入 `needsReview`，不會憑空擴充官方 taxonomy。
- 預設走決定性規則（`source: "rule"`，沿用 `DEFAULT_RULES` 關鍵字加上 taxonomy 掃描）；可注入本地 `model` stub，失敗或缺模型時自動落回規則，不呼叫外部 LLM API。
- `userClassification` 的欄位永遠優先（`source: "user"`）；自動分類只填空的維度，provider metadata 只算證據而非事實（信心度 < 1）。
- 透過 MusicLibrary 公共 API 持久化：`persistClassification(library, trackInput, result)` 用 `upsertTrack` 寫維度欄位、`addTag` 寫 `custom_tags`、完整 provenance JSON 存進 `sync_state` 的 `classification.<trackId>`。重新分類時使用者設過的維度與標籤不會被覆寫，tags 只增不減。

## 本機音樂庫

Server 啟動時會開啟一個本機 SQLite 音樂庫（`node:sqlite`），作為 Personal Music Library 的持久層：YouTube 仍是播放器，本機 DB 負責保存曲目、來源對應、tags、播放清單 mapping、aliases 與 `sync_state`。`save_music` 會寫入此庫（tracks、sources、tags、播放清單 mapping 與分類 provenance）；底層的 `youtube_save_track` 仍只操作 YouTube。

- 預設位置：使用者設定目錄下的 `music-playlist-organizer/library.sqlite`（Windows 為 `%APPDATA%\music-playlist-organizer\library.sqlite`；其他平台為 `~/.config/music-playlist-organizer/library.sqlite`）。
- 覆寫路徑：設定環境變數 `MUSIC_LIBRARY_FILE`（相對路徑會解析為絕對路徑）。
- 備份：先關閉 server（關閉時會做 WAL checkpoint），再複製 `library.sqlite`；若仍看到 `-wal`/`-shm` 檔，請一併複製。
- 重置：關閉 server，刪除 `library.sqlite`，重新啟動即會重建空 schema。
- OAuth token、refresh token、client secret 與 `YOUTUBE_CREDENTIAL_PASSPHRASE` 一律留在加密憑證檔，不會寫入音樂庫 DB、log 或 MCP 輸出；寫入端也會拒絕疑似 secret 的欄位名稱。

## 音樂庫查詢與維護

音樂庫內容透過以下工具查詢與整理（實作在 `src/library-query.js`，SQL 集中在 `MusicLibrary`）。所有查詢皆唯讀、分頁有界（`limit` ≤ 100），穩定識別一律用本機 `trackId` 與精確 YouTube ID，不用顯示名稱當唯一鍵：

- `search_library`：依 `title`／`artist`（LIKE＋正規化，支援 CJK）、`tag`、`genre`、`mood`、`language`、`activity` 過濾，回傳 `items`＋`total`＋`hasMore`。
- `list_music`：全庫分頁（`limit`／`offset`），最新收藏在前。
- `recent_music`：最近收藏的曲目，有界。
- `get_music`：單一 `trackId` 的完整檔案——canonical 欄位、sources、tags、playlists、分類記錄、`sync` 狀態與 identity review 項目。
- `update_music_tags`：對單曲新增／移除自訂標籤，回傳 before/after；不碰其他維度或 user-set metadata。
- `reclassify_music`：對單曲重跑自動分類，使用者設過的維度與標籤保留，回傳變更前後的 per-dimension diff。
- `remove_music`：預設 `preview`。`apply` 只執行明確授權的 effect——`local: true` 刪本機曲目（連同 sources、tags、playlist mapping、aliases、identity candidates、sync_state）；`youtubePlaylist`（**精確 playlist ID 或 URL**，名稱會被拒絕）＋可選 `videoId` 刪 YouTube playlist item。兩個 effect 獨立執行、各自回報 `writeState`，一邊失敗不會回滾另一邊；未授權任何 effect 的 apply 是明確 no-op（`no_effect_authorized`）。
- `list_unsynced_music`：列出需要注意的曲目——`not_synced`（不在任何 provider playlist）、`identity_conflict`（`needs_review`）、`provider_unavailable`（`sync.<trackId>` 標記為非 synced 狀態）；可用 `reason` 過濾。

## YouTube ↔ 音樂庫同步

同步工具在 `src/library-sync.js`，讓音樂庫與 YouTube playlist 不再無限漂移。設計原則：預設不做雙向破壞性同步；先產生 plan；`push`／`pull`／`reconcile` 語意分離；playlist 只用精確 ID 識別（名稱可改名，ID 不變）；provider read-back 是事實來源，但不會覆寫本機 tags 或 canonical 合併決策。

- `sync_status`：唯讀掃描。回報每首歌的穩定狀態——`in_sync`、`local_only`（音樂庫有、playlist 沒有）、`conflict`（`needs_review`）、`unknown_after_write`（上次寫入結果不確定）、`unknown`（playlist 讀取失敗）；以及 remote 端的 `youtube_only`、`unlinked`（本機有該 source 但缺 playlist 關聯）、`unavailable`（deleted/private）。可用 `playlist`（精確 ID 或 URL）限定範圍。
- `sync_youtube`：預設 `preview` 回傳明確 plan（`additions`／`imports`／`removals`／`renames`／`links`／`sourceMarks`／`markerResolutions`），不做任何 provider 寫入。`apply` 只執行預覽授權的 `direction` 與範圍：
  - `push`：把 `local_only` 曲目補進 playlist；已在 playlist 內的不會重複加；`allowRemoval: true` 才會另外移除 `youtube_only` 項目（破壞性操作需額外授權）。
  - `pull`：把 `youtube_only` 影片以 `upsertTrack` 匯入音樂庫，走原有 dedup 與 playlist 精確 ID 關聯。
  - `reconcile`：只修本機狀態，不做 provider 寫入——同步 playlist 改名（不會新建重複 playlist）、標記 `unavailable` source、補 `unlinked` 關聯、用已讀回的項目解 `unknown_after_write` marker。
  - 寫入遇到 timeout/5xx/429 不盲目 retry：該筆標記 `unknown_after_write`，整體回 `reconciliation_required`。
- `reconcile_track`：對單曲做 exact-ID read-back——逐 source 呼叫 `getVideo` 判斷 deleted/private（標 `unavailable`，**不刪** canonical track）、對 linked playlist 讀回 membership、`unknown_after_write` 解為 `synced`／`local_only`／`unavailable`。

同步狀態存在 `sync.<trackId>` marker（JSON，無 secrets），與 `list_unsynced_music` 的 `provider_unavailable` 過濾相容。schema v3 在 `track_sources` 增加 `status` 欄位（`ok`／`unavailable`），source 失效不等於歌曲消失。

## HTTP 介面（本機限定）

`src/http-server.js` 提供受保護的 REST facade，供手機／Web UI 操作**同一套** service layer——所有路由直接委派 `saveMusic`、`library-query`、`library-sync`，preview/apply、exact ID、reconciliation 語意與 stdio MCP 完全一致，不重複實作。

啟動（只綁 localhost）：

```bash
node src/http-server.js                 # 127.0.0.1:8741
MUSIC_HTTP_PORT=9000 node src/http-server.js
```

Session 流程：

```bash
curl -X POST http://127.0.0.1:8741/session \
  -H 'Content-Type: application/json' \
  -d '{"token":"<MUSIC_HTTP_BOOTSTRAP_TOKEN>"}'
# → {"token":"<session>","expiresAt":"..."}
curl http://127.0.0.1:8741/api/library/tracks -H "Authorization: Bearer <session>"
curl -X DELETE http://127.0.0.1:8741/session -H "Authorization: Bearer <session>"   # revoke
```

環境變數：`MUSIC_HTTP_HOST`（預設 `127.0.0.1`，**不要**設 `0.0.0.0` 除非前面有 TLS + 反向代理＋自有認證層）、`MUSIC_HTTP_PORT`（預設 8741）、`MUSIC_HTTP_BOOTSTRAP_TOKEN`（未設時啟動產生隨機值印在 stderr）、`MUSIC_HTTP_ALLOWED_ORIGINS`（逗號分隔；預設只允許 `http://localhost`/`http://127.0.0.1`，攜帶其他 Origin 的瀏覽器請求一律 403）。

安全界線：session token 與 YouTube OAuth 憑證完全分離，API 回應永不含 access/refresh token 或 credential passphrase；request body 上限 64 KB 且每個路由只收白名單欄位（client 無法注入 credential path）；effectful endpoint 併發上限 4，超出回 429；所有錯誤為 `{error:{code,message}}` 結構。

路由：`GET /health`、`GET /version`（免認證）；`POST /session`、`DELETE /session`；`GET /api/library/{tracks,recent,search,unsynced,tracks/:id}`、`POST /api/library/tracks/:id/{tags,reclassify}`、`POST /api/library/remove`；`POST /api/save_music`；`GET /api/sync/status`、`POST /api/sync`、`POST /api/reconcile`。

## 批次匯入

`src/batch-import.js` 把既有 YouTube / YouTube Music 收藏一次帶進音樂庫，不必逐首 `save_music`。管線：parse → resolve → canonicalize → dedupe → preview plan → apply → 可選 YouTube 同步。

- `preview_import`：接受 `items`（混合 URL／video ID／每行純文字歌名）與／或 `playlist`（精確 ID 或 URL）。回傳 `batchId` ＋ `counts`（`total`/`new`/`exactDuplicate`/`canonicalDuplicate`/`unresolved`/`unavailable`）＋逐項解析狀態（`resolvedBy`: `url`/`id`/`search`/`playlist`）。不寫曲目、不碰 provider；plan 存進 `import.<batchId>` sync_state 供 apply 使用。單筆超過 500 項時 `items` 截斷並標 `truncated`。
- `import_music_batch`：傳同樣輸入（重新解析）或 `batchId`＋`resume:true`（接續中斷的批次）。只寫入已解析項目；逐項回 `imported`/`exact_duplicate`/`canonical_duplicate`/`review`（低信心身份留待確認）/`unresolved`/`unavailable`/`failed`，單項失敗不回滾其他項；同批重跑全部報 `exact_duplicate`，是冪等的。預設**只寫本機 Library**——要同步到某個 YouTube playlist 必須每次呼叫明確傳 `syncPlaylist`（精確 ID/URL），已在 playlist 內的不重複加。
- `import_status`：查已存批次的 `counts`＋`done`/`pending`。

取消／逾時：apply 每 25 項 chunk flush 一次 plan；caller abort 後回 `action:"cancelled"` ＋ `remaining` ＋ `batchId`，之後用 `resume:true` 安全續作。

## Canonical 曲目識別與去重

音樂庫以「歌曲」為單位去重（schema v2）：一筆 `tracks` 是一個 canonical track，一個 canonical track 可掛多筆 `track_sources`（不同 `videoId` 的 MV、Official Audio、歌詞版等）。正規化邏輯集中在 `src/canonical.js`：

- 標題／藝人先經 NFKC、大小寫、拉丁 diacritics、標點與全半形正規化（CJK 組合符如濁點保留），再剝除 `feat.`/`ft.`、`(Official Video)`、`[MV]`、`Official Audio`、`Lyrics`、`- Topic` 後綴、`Artist - Title` 前綴等包裝性詞彙。
- `canonical_key = ct|<normalizedArtist>|<normalizedTitle>|<version>`：`version` 只在 live、cover、remix、remaster、acoustic 等「不同錄音版本」時才有值（如 `live:at wembley`）；Official MV 與 Official Audio 的 key 相同，因此會掛成同一首歌的兩個 source。
- 每筆 source 記錄 `source_type`（`official_video | official_audio | live | lyrics | cover | remix | remaster | unknown`）、匹配置信度與 provenance（JSON）。

`upsertTrack` 回傳 `identity` 欄位：`state` 為 `created | existing | same_canonical | possible_match`，`level` 為四級去重結果：

| level | 意義 |
|---|---|
| `EXACT_SOURCE_DUPLICATE` | 同一 provider + sourceId，冪等更新 |
| `SAME_CANONICAL_TRACK` | canonical key 相同（含 merge 記憶 alias），掛為新 source |
| `POSSIBLE_MATCH` | 模糊命中（同名不同版本、同名不同藝人、近似標題）：**不**自動合併，另建曲目並標 `needs_review`，候選寫入 `identity_candidates` |
| `DISTINCT_TRACK` | 無相近候選，建新曲目 |

人工決策永遠優先於自動流程：

- `mergeTracks(intoId, fromId)`：把 from 的 sources、tags、playlists、aliases 全部併入 into 並刪除 from；from 的 canonical key 會存成 into 的 `canonical_key` alias，之後同 key 的新來源仍自動掛進來。
- `splitTrack(trackId, sourceIds, { title?, artist?, ... })`：把指定 sources 拆到一個新曲目（新曲目 `identity_locked = 1`），並撤銷原曲目上對應的 canonical_key alias。
- `identity_locked` 的曲目不會成為自動掛載目標：同 key 新來源會落入 `possible_match`（reason `identity_locked`）。`setIdentityLocked(trackId, false)` 可解除。
- `previewIdentity(input)` 為唯讀預覽：回傳正規化結果與將採用的去重決策，不寫入任何資料。
- `identityReviewQueue()` 列出所有待審候選配對（含信心值與原因）；`setNeedsReview(trackId, false)` 可手動清除標記。

## 需求

- Node.js 24 或更新版本（`node:sqlite`）。
- YouTube Data API key：用於公開搜尋與影片資訊；若不設定，catalog read 會改用 YouTube OAuth。
- Google OAuth 2.0 client：列出、建立與修改自己的播放清單時需要。
- OAuth scope：`https://www.googleapis.com/auth/youtube`。

## 安裝與設定

```powershell
Copy-Item .env.example .env
npm install
npm test
```

`.env` 的 YouTube 相關設定：

```dotenv
YOUTUBE_API_KEY=
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
YOUTUBE_OAUTH_REDIRECT_URI=http://127.0.0.1:53682/oauth2callback

# 建議使用加密憑證檔，不要把 token 貼進設定檔。
YOUTUBE_CREDENTIAL_FILE=
YOUTUBE_CREDENTIAL_PASSPHRASE=use-a-local-secret-not-committed-to-git

YOUTUBE_REGION=TW
YOUTUBE_PLAYLIST_PREFIX=
PROVIDER_TIMEOUT_MS=15000
PROVIDER_MAX_READ_RETRIES=1
```

首次授權請執行：

```powershell
npm run youtube:auth
```

這個流程會使用 OAuth state 與 PKCE，開啟瀏覽器完成 Google 授權，並把 token 寫入本機 AES-256-GCM 加密檔。終端機只會顯示檔案位置與完成狀態，不會顯示 access token 或 refresh token。執行 MCP Server 時，仍須讓它取得同一個 `YOUTUBE_CREDENTIAL_PASSPHRASE`；不要把 passphrase、`.env` 或憑證檔提交到 Git。

`YOUTUBE_CREDENTIAL_FILE` 未設定時，預設位置是使用者設定目錄下的 `music-playlist-organizer/youtube-credentials.json`。`YOUTUBE_ACCESS_TOKEN` 與 `YOUTUBE_REFRESH_TOKEN` 仍可作為明確的本機 fallback，但不建議在一般部署中使用，也不要提交到 repository。

## 使用範例

先取得候選，不會寫入帳號：

```text
youtube_identify_track({
  "input": "Daft Punk One More Time",
  "limit": 5
})
```

使用者從回傳的 `candidates` 選定 `videoId` 後再收藏：

```text
youtube_save_track({
  "input": "Daft Punk One More Time",
  "videoId": "dQw4w9WgXcQ",
  "category": "Party",
  "mode": "apply",
  "createIfMissing": true,
  "privacyStatus": "private",
  "dedupe": true
})
```

精確連結可以直接使用：

```text
youtube_save_track({
  "input": "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
  "category": "Chill",
  "mode": "apply"
})
```

若寫入期間發生 timeout、取消、網路錯誤、429 或 5xx，工具會回傳 `UNKNOWN_AFTER_WRITE` 或 `PARTIAL_PLAYLIST_CREATED`，包含已確認的 playlist ID、video ID 與 `completedSteps`。請先依回傳的 exact ID 讀取播放清單，再決定是否重試；寫入不會自動重試。

## MCP Client 設定

把專案的絕對路徑填入 `args`，並讓 MCP process 取得加密憑證的 passphrase：

```json
{
  "mcpServers": {
    "music-playlist-organizer": {
      "command": "node",
      "args": ["C:\\path\\to\\spotify-playlist-organizer-mcp\\src\\server.js"],
      "env": {
        "YOUTUBE_API_KEY": "your-youtube-data-api-key",
        "GOOGLE_CLIENT_ID": "your-google-oauth-client-id",
        "GOOGLE_CLIENT_SECRET": "your-google-oauth-client-secret",
        "YOUTUBE_CREDENTIAL_PASSPHRASE": "load-this-from-your-local-secret-manager",
        "YOUTUBE_REGION": "TW"
      }
    }
  }
}
```

目前 server 使用 stdio MCP。Figma 手機頁面原型已建立，但要讓手機頁面直接操作 MCP，下一階段還需要受保護的 HTTP API／session layer；MCP 核心收藏流程已先完成。

## Spotify legacy provider

既有的 `spotify_*` 工具仍保留，包括搜尋、辨識、批次解析、重複檢查、分類與播放清單整理；不設定 Spotify 環境變數時，不會影響 YouTube 工具。

## 品質控制

```powershell
npm test
npm run smoke
```

GitHub Actions 會在 push 與 pull request 執行 `npm ci`、`npm test`，並對 job 設定時間上限與 read-only repository 權限。

## 官方文件

- [YouTube Data API](https://developers.google.com/youtube/v3)
- [YouTube OAuth 2.0](https://developers.google.com/youtube/v3/guides/authentication)
- [YouTube 播放清單實作](https://developers.google.com/youtube/v3/guides/implementation/playlists)
- [playlistItems.insert](https://developers.google.com/youtube/v3/docs/playlistItems/insert)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

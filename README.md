# Music Playlist Organizer MCP

這是一個以 Node.js 撰寫的 MCP Server，讓你把找到的歌曲名稱或 YouTube／YouTube Music 連結，辨識後分類、去重，並加入自己的 YouTube 播放清單，之後可以直接回到 YouTube 觀看。

目前以 YouTube 為主要 provider；Spotify 工具仍保留，但屬於選配的 legacy provider。

## 收藏流程

對「歌曲名稱或搜尋文字」建議採用兩階段流程，避免搜尋結果第一名不是你想收藏的影片：

1. 呼叫 `youtube_identify_track`，取得候選影片與 `videoId`。
2. 使用者確認候選後，把選定的 `videoId` 傳給 `youtube_save_track`，並設定 `mode: "apply"`。
3. Server 依分類找到或建立播放清單，檢查相同 `videoId` 後才加入。

如果輸入本身是精確的 YouTube／YouTube Music 影片連結，可以直接套用；播放清單連結不能當成單一歌曲輸入。

## YouTube 工具

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

## 需求

- Node.js 20 或更新版本。
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

# Music Playlist Organizer MCP

這是一個以 Node.js 撰寫的 MCP Server，現在以 YouTube／YouTube Music 連結作為主要輸入，協助辨識歌曲、分類、去重，並寫入使用者的 YouTube 播放清單。Spotify 功能仍保留為選配的 legacy provider。

## 目前功能

### YouTube-first

- `youtube_search_videos`：搜尋歌曲、藝人或影片。
- `youtube_identify_track`：從 YouTube URL、YouTube Music URL、影片 ID 或文字搜尋辨識影片。
- `youtube_resolve_links`：批次解析多個 YouTube 連結。
- `youtube_list_playlists`：列出已授權帳號的 YouTube 播放清單。
- `youtube_create_playlist`：建立私人、未列出或公開播放清單。
- `youtube_check_playlist_duplicates`：檢查播放清單內的重複影片。
- `youtube_classify_playlist`：依標題與頻道關鍵字產生分類預覽。
- `youtube_add_to_playlist`：預覽或將影片加入既有播放清單。
- `youtube_save_track`：辨識、分類、去重，並加入指定或自動建立的分類播放清單。

### Spotify legacy provider

既有的 `spotify_*` 工具仍然保留，包括搜尋、辨識、批次解析、重複檢查、分類與播放清單整理；不設定 Spotify 環境變數時，不會影響 YouTube 工具的使用。

## 需求

- Node.js 20 或更新版本。
- YouTube Data API key，用於公開搜尋與影片資訊；若改用 OAuth 讀取，也可以不設定 API key。
- Google OAuth 2.0 client。
- YouTube 使用者 OAuth token 或 refresh token，並授權 `https://www.googleapis.com/auth/youtube` scope，才能列出、建立與修改播放清單。

## 安裝

`powershell
Copy-Item .env.example .env
npm install
npm test
`

YouTube 環境變數：

`dotenv
YOUTUBE_API_KEY=your-youtube-data-api-key
GOOGLE_CLIENT_ID=your-google-oauth-client-id
GOOGLE_CLIENT_SECRET=your-google-oauth-client-secret
YOUTUBE_ACCESS_TOKEN=your-user-access-token
# 或改用 refresh token
YOUTUBE_REFRESH_TOKEN=your-refresh-token
YOUTUBE_REGION=TW
YOUTUBE_PLAYLIST_PREFIX=
YOUTUBE_OAUTH_REDIRECT_URI=http://127.0.0.1:53682/oauth2callback
`

不要把 `.env`、access token 或 refresh token 提交到 Git。

若尚未取得使用者 token，先在 Google Cloud 建立 OAuth client，將 client ID、secret 與 redirect URI 填入 `.env`，再執行：

`powershell
npm run youtube:auth
`

開啟終端機列出的 Google 授權網址，完成授權後把終端機顯示的 `YOUTUBE_ACCESS_TOKEN` 與 `YOUTUBE_REFRESH_TOKEN` 放入 `.env`。

## 使用範例

先預覽，不會寫入帳號：

`text
youtube_save_track({
  "input": "https://www.youtube.com/watch?v=VIDEO_ID",
  "category": "Chill",
  "mode": "preview"
})
`

確認結果後再套用：

`text
youtube_save_track({
  "input": "https://music.youtube.com/watch?v=VIDEO_ID",
  "category": "Chill",
  "mode": "apply",
  "createIfMissing": true,
  "privacyStatus": "private",
  "dedupe": true
})
`

若不指定 `playlist`，系統會使用分類名稱作為播放清單名稱，例如 `Chill`；若播放清單不存在，`mode: "apply"` 且 `createIfMissing: true` 時會自動建立。

## MCP Client 設定

把專案的絕對路徑填入 `args`：

`json
{
  "mcpServers": {
    "music-playlist-organizer": {
      "command": "node",
      "args": ["C:\\path\\to\\spotify-playlist-organizer-mcp\\src\\server.js"],
      "env": {
        "YOUTUBE_API_KEY": "your-youtube-data-api-key",
        "GOOGLE_CLIENT_ID": "your-google-oauth-client-id",
        "GOOGLE_CLIENT_SECRET": "your-google-oauth-client-secret",
        "YOUTUBE_REFRESH_TOKEN": "your-refresh-token",
        "YOUTUBE_REGION": "TW"
      }
    }
  }
}
`

目前 server 是 stdio MCP。Figma 手機頁面要直接呼叫它時，下一階段需要再加一層 HTTP API 與 OAuth callback；MCP 工具本身已先完成收藏流程的核心邏輯。

## 官方文件

- [YouTube Data API](https://developers.google.com/youtube/v3)
- [YouTube OAuth 2.0](https://developers.google.com/youtube/v3/guides/authentication)
- [YouTube 播放清單實作](https://developers.google.com/youtube/v3/guides/implementation/playlists)
- [playlistItems.insert](https://developers.google.com/youtube/v3/docs/playlistItems/insert)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

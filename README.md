# Spotify Playlist Organizer MCP

一個以 Node.js 撰寫的 MCP Server，讓相容的 AI 用 Spotify Web API 搜尋、辨識、檢查重複歌曲，並預覽或建立分類播放清單。

## 功能

- `spotify_search_tracks`：以歌名、藝人、專輯或自由文字搜尋歌曲。
- `spotify_identify_track`：處理 Spotify 連結、YouTube 連結、ISRC、歌名與藝人。
- `spotify_resolve_links`：批次把 Spotify／YouTube 連結解析成 Spotify 歌曲候選。
- `spotify_check_playlist_duplicates`：找出播放清單中的重複歌曲與所在位置。
- `spotify_classify_playlist`：依標題、藝人、專輯關鍵字產生分類預覽。
- `spotify_organize_playlist`：預設只預覽；`mode: "apply"` 才會建立或更新分類播放清單。

## 需求與安裝

- Node.js 18 或更新版本。
- Spotify Developer App 的 `Client ID` 與 `Client Secret`。
- 搜尋可使用 Client Credentials；播放清單讀寫需要 Spotify 使用者 Token 或 Refresh Token。

```powershell
Copy-Item .env.example .env
npm install
npm test
```

在 `.env` 填入：

```dotenv
SPOTIFY_CLIENT_ID=your-client-id
SPOTIFY_CLIENT_SECRET=your-client-secret
SPOTIFY_ACCESS_TOKEN=your-user-access-token
# 或改用具備相同權限的 refresh token
SPOTIFY_REFRESH_TOKEN=your-refresh-token
SPOTIFY_MARKET=TW
```

使用者 Token 至少需要：

- `playlist-read-private`
- `playlist-read-collaborative`
- `playlist-modify-private`
- `playlist-modify-public`

請勿把 `.env` 或任何 Token 提交到 Git。

## MCP 設定

把下列設定加入 MCP Client，並將路徑改成此專案的絕對路徑：

```json
{
  "mcpServers": {
    "spotify-playlist-organizer": {
      "command": "node",
      "args": ["C:\\path\\to\\spotify-playlist-organizer-mcp\\src\\server.js"],
      "env": {
        "SPOTIFY_CLIENT_ID": "your-client-id",
        "SPOTIFY_CLIENT_SECRET": "your-client-secret",
        "SPOTIFY_ACCESS_TOKEN": "your-user-access-token",
        "SPOTIFY_MARKET": "TW"
      }
    }
  }
}
```

啟動方式：

```powershell
npm start
```

## 使用方式

播放清單工具接受 Spotify 播放清單網址、URI 或 ID。例如：

```text
spotify_check_playlist_duplicates({
  "playlist": "https://open.spotify.com/playlist/your-playlist-id"
})
```

先呼叫 `spotify_organize_playlist` 的預設 `preview` 模式查看計畫，再明確使用 `mode: "apply"`。套用時只會建立或更新名稱完全符合分類計畫的衍生播放清單，不會修改來源播放清單。

YouTube 影片透過公開 oEmbed 取得標題與藝人提示，再搜尋 Spotify；若影片無法提供 oEmbed 資料，請改用歌名與藝人搜尋。

## 官方文件

- [Spotify Web API](https://developer.spotify.com/documentation/web-api)
- [Spotify Client Credentials Flow](https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow)
- [Spotify Authorization Code Flow](https://developer.spotify.com/documentation/web-api/tutorials/code-flow)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

# AGENTS.md — repo 工作指引

## 產品定位

Local-first Personal Music Library：canonical track 存 SQLite，多個 YouTube source 在「歌」層級去重；MCP stdio 是主要介面，localhost HTTP 是給未來 mobile/Web UI 的 facade。安全預設：preview before apply、exact ID、read-back 驗證、不明確的 provider 寫入要回報 `UNKNOWN_AFTER_WRITE` 而不是假裝成功。

## 架構地圖

- `src/library.js` — 所有 SQL、schema migration（目前 v3）、`MusicLibrary` 類。**SQL 只准在這裡**，handler 不下查詢。
- `src/canonical.js` — title/artist 正規化與 canonical_key；`src/taxonomy.js` 分類維度；`src/classify.js` 分類執行（user-set 永不被覆寫）。
- `src/save-music.js` — 產品入口 `save_music`（preview/apply）。
- `src/library-query.js` — 查詢/維護 tools；`src/library-sync.js` — YouTube↔Library 同步；`src/batch-import.js` — 批次匯入（plan 存 `import.<batchId>` sync_state）；`src/library-backup.js` — 匯出/還原；`src/playlist-admin.js` — playlist 管理；`src/http-server.js` — REST facade。
- `src/youtube.js` — provider client（唯一碰真實 API 的層）；`src/server.js` — MCP tool 註冊（薄，6% 覆蓋是可接受的）。
- `src/spotify.js` — legacy provider，低覆蓋，YouTube-first 路線下地位未定。

## 不可回歸的坑（修過的，別再造回來）

1. name-only playlist 不可按 provider 壓成同一列；lookup 用 provider+playlistId 或 provider+name 且 playlist_id IS NULL。
2. `setSyncState` 物件 value 必須過 `assertNoSecretKeys`；OAuth/passphrase 不得進 Library DB。
3. `server.js` 用 `export createServer + main()`；import 不得開真實 DB；close 時 WAL checkpoint。
4. `sourceType`/`versionType` 的 live/cover/remix/remaster 必須進 canonical_key。
5. `identity_locked` 的 alias attach 必須擋下（possible_match / identity_locked）。
6. `openLibrary` 的 backfill 不可每次重開就翻 needs_review。
7. 同一 videoId 再 upsert 不可改 canonical_title/artist。
8. `splitTrack` 用被搬走的 source_type 算 key，並複製 playlist/tags。
9. `save_music`：自由文字未綁 videoId 必須 `selection_required`，禁止默默存搜尋第一名；YouTube 與 Library 失敗要分開回報，不盲目 retry。
10. Restore：`importRows` 的 idMap 必須在 first pass 就涵蓋 insert entry（insert 用原 id），否則 identity_candidates 靜默丟失。
11. MCP stdio server 的 SIGTERM/SIGINT handler 必須 `process.exit(0)`——Windows `child.kill()` 是強殺但 Linux 送真 signal，不 exit 會讓 CI/test 掛死。

## 品質指令

```powershell
npm test                # 每個 commit 必跑
npm run test:coverage   # CI 的 test step（V8 coverage 報表）
npm run lint            # ESLint flat config
npm run crap            # CRAP 報表（complexity × coverage），--gate N 可設閘
npm run mutate          # Stryker（慢，~7min/檔）；npx stryker run --mutate src/X.js
```

- Baseline（2026-09，`src/spotify.js` 不計入 coverage）：行 ~85% / 分支 ~78% / 函數 ~93%；`core.js` mutation 46.6%。棘輪門檻行≥80/分支≥75/函數≥90 在 `test:coverage` script 裡。CRAP top offender：`saveMusic` comp 99、`importRows` comp 79、server.js 註冊層（低覆蓋可接受）。
- Mutation 不進 CI（太慢）；CRAP 先報表不設閘；`src/spotify.js` legacy 去留待使用者決策。

## Git / 流程

- 整合分支是 `feat/issue-9-library`（source of truth）。`.worktrees/` 下的舊 worktree 不是權威。
- conventional commits；一張 issue 一個 commit。
- push、開 PR、關 GitHub issue、merge 一律需要使用者明確授權。
- TDD：先寫失敗測試再實作；跑全套件才算完成。

## 環境

- Node >= 24（用 `node:sqlite`）；零 runtime 依賴的設計偏好（node:http、node:test）。
- HTTP facade 預設綁 127.0.0.1；對外暴露需要 TLS + reverse proxy + 獨立 auth，不得讓 client 指定 credential 路徑、不得回傳 OAuth token/secret。

# CI 回歸驗證紀錄 — Issue #5

- 日期：2026-10-01
- 對象：`.github/workflows/ci.yml`（`push`／`pull_request` 觸發，單一 `test` job）
- Runner：ubuntu-latest、Node.js 24（對應 `package.json` 的 `engines: >=24`）
- Job 邊界：`timeout-minutes: 5`、`permissions: contents: read`，未注入任何 OAuth／API secret
- 指令順序：`npm ci` → `npm run lint` → `npm run test:coverage`（同一套 `node --test` 完整套件，含 `test/mcp-smoke.test.js`，coverage 棘輪：行 ≥80／分支 ≥75／函數 ≥88）

## 實際觸發的 run

| 被測 SHA | event | run URL | 結果 |
|---|---|---|---|
| `23db826f` | push | https://github.com/Reese-max/spotify-playlist-organizer-mcp/actions/runs/36807373375 | success（23s） |
| `23db826f` | pull_request | https://github.com/Reese-max/spotify-playlist-organizer-mcp/actions/runs/36807373690 | success |
| `164f4d9e`（負向探針） | push | https://github.com/Reese-max/spotify-playlist-organizer-mcp/actions/runs/36807449647 | **failure** |
| `164f4d9e` | pull_request | https://github.com/Reese-max/spotify-playlist-organizer-mcp/actions/runs/36807452858 | **failure** |
| `e433d159`（revert 探針） | push | https://github.com/Reese-max/spotify-playlist-organizer-mcp/actions/runs/36807503138 | success（22s） |
| `e433d159` | pull_request | https://github.com/Reese-max/spotify-playlist-organizer-mcp/actions/runs/36807507342 | success |

最終文件 commit 的 run 收錄於 PR #55 的檢查紀錄。歷史上另有 8 筆真實回歸失敗 run（head SHA `c02a0bd1`、`85ba2cdc`、`7865868b`、`dfa67f90` 等），顯示閘門對非刻意破壞也會觸發。

## 負向驗證（隔離測試變更 → CI 失敗 → 復原通過）

`164f4d9e` 只把 `test/ci-workflow.test.js` 的 timeout 期望改成錯誤值 `999`（單行、可還原）：push 與 pull_request run 都在 `Run tests with coverage` 步驟以 exit 1 失敗。`e433d159` revert 後同 workflow 轉 success。過程未刪除任何測試，也未把失敗轉為警告——workflow 不含 `continue-on-error`，並由 `test/ci-workflow.test.js` 鎖住該契約。

## 憑證與 provider 邊界

- workflow 沒有任何 `secrets.` 參照，runner 不持有 YouTube／Spotify OAuth 或 API key。
- 套件全走 stub provider：不修改真實播放清單，輸出不應含 secrets。

## 未涵蓋範圍

- 只驗證 ubuntu-latest × Node 24：Windows／macOS 與其他 Node 版本未涵蓋。
- 真實 provider 網路行為（quota、token refresh、實際播放清單寫入）不在 CI 範圍，仍靠 stub。
- `src/spotify.js`（legacy）不計入 coverage；`npm run mutate` 與 `npm run crap` 刻意不進 CI 閘。

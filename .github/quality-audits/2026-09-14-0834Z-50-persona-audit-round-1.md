# 固定 50-Persona Audit — Round 1

- Round ID: `spotify-playlist-organizer-mcp-R1-20260914T0834Z`
- 稽核規範：`Reese-max/autodev-ng/docs/portfolio-audit/2026-09-06-50-persona-audit.md`
- 規範 blob SHA：`6e3499d6ef5be7e123050e1526946f6a40f99263`
- Default branch：`main`
- 本輪開始／寫入前 inspected HEAD：`6ffeca21c1409f105ec49120bbc4b00f7a5908ea`
- 相關產品 SHA：`28589712445e2229d79a1644b360425467ab7404`
- `6ffeca21...` 僅新增 product-board audit 文件，不視為產品修正或 runtime 證據。
- Umbrella Issue：[#7](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/7)

> 本報告使用規範固定的 A01–J05，共 10 組、每組 5 人。所有 persona 結果皆為**合成模擬**，不是真人測試、訪談或遙測。此輪沒有沿用 product-board audit 的動態／輪替 persona。

## 結論

**NOT CLEAN — CLEAN streak 0/2。**

- 固定 50 persona 靜態／證據推演覆蓋：**50/50**。
- 完整 CLEAN 合格輪次：**NO**。原因為仍有 open P1/P2，且核心寫入、OAuth、timeout/cancel、無障礙／外部 MCP client、真實 provider 路徑缺乏有效 runtime execution evidence。
- 新 finding：**P2 #6** — provider/OAuth request 無有限 deadline／caller cancellation propagation。
- 既有 finding 去重沿用：#2、#3、#4、#5；未重複建 Issue。
- #1 保持 `RESEARCH_REQUIRED / UNKNOWN`，不因推測自行升級成 P0/P1/P2。
- 本輪發現新 P2，因此 consecutive qualifying CLEAN rounds 維持／重設為 **0/2**。

## Finding 對應

| ID | Sev | Fingerprint 摘要 | 狀態 | Issue | 信心／證據 |
|---|---:|---|---|---|---|
| F-01 | P1 | free-text search top-1 → 未審核 identity → apply write | OPEN / STILL_REPRODUCIBLE（source） | [#2](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/2) | CONFIRMED source；真實 match 品質 UNKNOWN |
| F-02 | P1 | OAuth bootstrap → raw access/refresh token stdout/manual copy | OPEN / STILL_REPRODUCIBLE（source/docs） | [#3](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/3) | CONFIRMED source/docs；實際外洩事件 UNKNOWN |
| F-03 | P2 | create succeeds → insert fails/unknown → generic error hides partial state | OPEN / STILL_REPRODUCIBLE（source） | [#4](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/4) | CONFIRMED source；provider timing NEEDS_RUNTIME_VERIFICATION |
| F-04 | P1 | default-branch change → tests exist but no CI admission receipt | OPEN | [#5](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/5) | CONFIRMED GitHub Actions `total_count: 0` |
| F-05 | P2 | provider/OAuth fetch stalls → MCP call has no finite bound/cancel propagation | **NEW / OPEN** | [#6](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/6) | CONFIRMED source；frequency/runtime UNKNOWN |
| R-01 | — | Spotify provider content → AI/model-visible boundary policy interpretation | RESEARCH_REQUIRED | [#1](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/1) | policy text tracked；client-dependent interpretation UNKNOWN |

## 核心證據

### Source / docs

- `README.md`：Node 20+、stdio MCP、YouTube-first、OAuth 寫入、preview→apply；手機/Figma 直接呼叫尚需另加 HTTP API/OAuth callback。
- `src/server.js`：`safeTool()` 只等待 handler 並將 thrown error 包成 error result；free-text resolve 使用搜尋候選；`youtube_save_track` 可在 `apply` 中建立 playlist 後再 insert。
- `src/youtube.js`：YouTube API 與 OAuth refresh 使用 `fetch(...)`；現行 request contract 未帶 `AbortSignal` 或 deadline。
- `src/spotify.js`：Spotify API／token refresh 與 YouTube oEmbed 同樣直接 await `fetch(...)`，沒有 repository-defined deadline/cancel contract。
- `test/youtube.test.js`：有成功 search/list/create/add mocked tests；沒有 never-resolving fetch、caller abort、timeout cleanup fixture。

### GitHub / runtime boundary

- `main` 的 GitHub Actions 查詢：`total_count: 0`。因此**沒有**聲稱 current SHA 在 GitHub-hosted runner 上通過 tests。
- 本輪嘗試在隔離 audit container 取得 repo 後執行 local tests，但環境在 checkout 前即因無法解析 `github.com` 而停止；此為稽核環境限制，**不是 repository test failure**，也不構成 local runtime pass。
- 未使用真實 OAuth token、未呼叫付費／正式 provider mutation、未修改正式 playlist、未做部署、未做真實 assistive-technology 或 mobile UI 測試。

## 十個測試維度摘要

1. **首次成功**：README 能說明產品與 Node/MCP/OAuth 起點，但 write-enabled onboarding 目前含 #3 plaintext token handoff；真正首次成功尚無 runtime receipt。
2. **核心 happy path**：exact YouTube ID/URL → preview → apply 有清楚 source path；但未執行真實 provider write，故 `NEEDS_RUNTIME_VERIFICATION`。
3. **錯誤輸入／恢復**：Zod/parsers 有 source-level validation；partial mutation recovery 被 #4 阻塞。
4. **中斷／重複／重試**：exact-ID duplicate check 是正面 source evidence；部分成功與重試的 durable receipt/idempotent reconciliation 尚缺（#4）。
5. **timeout/429/5xx**：HTTP non-2xx 會轉為 provider error，但 request 本身沒有 deadline/cancellation；新 P2 #6。
6. **並行**：OAuth refresh 有 in-process promise dedupe 的正面 source evidence；playlist create/insert 的多次 concurrent invocation 尚無 operation-level reconciliation runtime evidence（#4）。
7. **權限／資料安全**：YouTube write 授權與 token 生命週期由 #3 阻塞；Spotify model-visibility boundary #1 仍是 research dependency。
8. **無障礙**：repo 是 stdio MCP，最終呈現主要由 MCP client 決定；structured response 是靜態正面訊號，但沒有 screen reader／keyboard execution evidence，且 generic partial-state error 影響 G02（#4）。
9. **手機／窄螢幕／CLI 非互動**：README 明示尚無直接 mobile/Figma HTTP layer；非互動 stdio 核心可由 MCP host 呼叫但未有 runtime receipt；H03 另受 #5/#6 影響。
10. **效能／成本／長時間**：pagination 有明確上限與 loop termination source path；provider quota/long-run 仍缺 execution evidence，stalled HTTP 無 finite bound 由 #6 追蹤。

## 固定 50 Persona × Scenario Matrix

證據層級縮寫：`SRC`=原始碼確認、`DOC`=文件、`ISSUE`=既有 GitHub finding、`GH`=GitHub metadata／Actions、`RUNTIME`=實際執行。本輪沒有可支持核心 provider 路徑的有效 RUNTIME 證據。

| Persona | 目標 | 前置／輸入 | 固定核心步驟 | 預期 | 觀察 | 證據 | Sev / Finding |
|---|---|---|---|---|---|---|---|
| A01 高中生／新手／手機優先 | 第一次收藏一首歌 | 未設定、YouTube URL | 讀 README→設定 MCP/OAuth→preview→apply | 不暴露秘密且完成收藏 | write onboarding 要經 terminal token handoff；純手機直連未提供 | DOC/SRC | P1 F-02 #3；mobile runtime UNKNOWN |
| A02 大學生／Docs 熟／CLI 生 | 完成首次授權與收藏 | 桌面可跑 Node | 安裝→OAuth→貼連結→preview/apply | 少 CLI 摩擦、秘密不出現在終端 | raw token copy 是既有核心授權路徑 | DOC/SRC | P1 F-02 #3 |
| A03 資工學生／Git/CLI | 自訂分類並安全提交變更 | local repo | 改規則→跑 tests→push/PR | exact commit 有 admission receipt | tests 存在但 main 無 Actions run/status | GH/SRC | P1 F-04 #5 |
| A04 考生／時間壓力 | 最快用歌名收藏 | free-text 曲名 | search→preview→apply | 不因省步驟寫錯版本 | source 直接以 top-1 作 match，可進 apply | SRC/ISSUE | P1 F-01 #2 |
| A05 視覺型／依賴狀態 | 看懂收藏是否成功 | missing playlist | preview→apply→provider 部分失敗 | 清楚顯示每一步狀態與下一步 | create 成功、insert 失敗時 generic error 不含已建立狀態 | SRC/ISSUE | P2 F-03 #4 |
| B01 行政／程式陌生 | exact-link 收藏 | 已由他人設定 MCP | 貼 exact URL→preview→apply | 核心流程可完成 | exact ID source path 明確；未做真實 provider write | SRC | NEEDS_RUNTIME_VERIFICATION |
| B02 初階工程師 | 可診斷 provider 失敗 | 模擬慢網路 | 呼叫 search/save→provider stall | finite timeout + actionable error | 無 deadline/cancel；且無 CI receipt | SRC/GH | P2 F-05 #6；P1 F-04 #5 |
| B03 設計師／重視可逆 | 失敗後知道是否改到 playlist | createIfMissing | apply→insert failure | 明確 partial/undo/reconcile 狀態 | generic error 隱藏已建立 playlist | SRC | P2 F-03 #4 |
| B04 研究助理／來源 | 確認收藏的是正確來源 | free-text | 搜尋→查看候選→apply | identity 有來源／決策軌跡 | top-1 可直接成為 write identity | SRC | P1 F-01 #2 |
| B05 輪班／手機碎片時間 | 手機快速收藏 | mobile only | 分享歌名/URL→收藏 | 手機可走支援的入口且不中斷 | repo 本身僅 stdio；README 明示 mobile HTTP layer 尚未做 | DOC | scope limitation；runtime UNKNOWN |
| C01 警政/公務／稽核 | 可追溯「哪首歌被加到哪裡」 | free-text + apply | resolve→approve→write→receipt | identity/effect/receipt 可稽核 | resolution 未 durable reviewed；partial outcome 不完整 | SRC/ISSUE | P1 #2 + P2 #4 |
| C02 教師／多人低學習 | 讓多人依指引使用 | 每人各自 MCP host | setup→exact-link save | 低學習成本、不混淆帳號 | 本 repo 是 local stdio；多使用者隔離非 server scope，OAuth setup 仍高摩擦 | DOC/SRC | P1 #3 for credential path；multi-user runtime UNKNOWN |
| C03 高風險錯誤防護 | 不洩漏憑證、錯誤 fail-safe | OAuth/write | auth→provider error | secrets 不進 output，失敗狀態可判讀 | bootstrap plaintext secret + generic/timeout gaps | SRC | P1 #3；P2 #6 |
| C04 內容創作者／長流程 | 中斷後安全恢復 | create then interruption | apply→process/network interruption→retry | 不重複建/加、可恢復 | 無 durable operation receipt/reconciliation | SRC | P2 F-03 #4 |
| C05 DevOps/SRE | 可觀測且有 bounded failure | provider stall/CI | run gate→invoke slow request | CI receipt + timeout/cancel + typed failure | Actions 0；provider request 無 finite bound | GH/SRC | P1 #5 + P2 #6 |
| D01 主管／摘要異常 | 一眼看懂異常是否改到資料 | partial write | 查結果摘要 | success/partial/failed 分明 | generic error 不能回答是否已建立 playlist | SRC | P2 #4 |
| D02 PM／進度追蹤 | 追蹤每個收藏 operation | repeated save | preview→apply→issue occurs | operation 有責任/狀態/receipt | 無 operation-level durable receipt | SRC | P2 #4 |
| D03 IT 管理員 | 安全部署本機 MCP | OAuth + environment | setup→rotate/revoke→upgrade | token 生命周期安全且 change 有 CI | token stdout/manual copy；無 default CI | DOC/GH | P1 #3 + P1 #5 |
| D04 成本敏感 | 避免無限等待／盲重試浪費 quota | provider slow/429 | request→retry | finite bound、成本可控、429 有 bounded policy | HTTP request 無 deadline；無 repository-defined finite retry policy for stalls | SRC | P2 #6；quota runtime UNKNOWN |
| D05 法遵/稽核 | 秘密與操作證據可稽核 | OAuth/write | setup→apply→review logs | token 不出 output，effects 可追蹤 | plaintext token path + partial receipt gap | SRC | P1 #3 + P2 #4 |
| E01 一般辦公／新式 UI 少 | 由已設定 MCP 完成收藏 | external MCP client | exact URL→preview→apply | 少步驟且狀態明確 | core source path 存在；client UI 與 provider runtime 未驗證 | SRC | NEEDS_RUNTIME_VERIFICATION |
| E02 教職公務／桌面大字 | 桌面完成收藏 | external MCP client | exact-link save | client 可讀、放大且狀態不丟失 | repo 無自有 GUI；render/accessibility 取決於 client，未執行 | DOC | NEEDS_RUNTIME_VERIFICATION |
| E03 低數位熟悉／怕按錯 | 誤操作可預覽、可復原 | default mode | call save without mode→then apply | 預設不寫入、授權秘密不暴露 | preview default 是正面 SRC；OAuth copy 仍不安全 | SRC/DOC | P1 #3；preview positive static evidence |
| E04 Excel熟／雲端陌生 | 本機安裝與使用 | Windows desktop | Node install→MCP config→exact save | 不需要部署知識 | local stdio 符合方向；未有 Windows end-to-end receipt | DOC | NEEDS_RUNTIME_VERIFICATION |
| E05 長時間使用 | 反覆收藏不會卡住 | many sequential saves | exact saves for long session | 長時間操作有 finite resource bounds | provider stall 無 deadline；long-run 未測 | SRC | P2 #6；runtime gap |
| F01 高齡初用 | 在外部 client 完成單一收藏 | 家人完成設定 | 貼 exact link→確認→apply | 明確一步一事 | repo 無自有 UI；MCP response 可結構化但 AT/client 未測 | SRC/DOC | runtime/client UNKNOWN |
| F02 視力弱 | 看懂結果 | external accessible client | save→inspect state | 不依小字/顏色 | presentation 不由 repo 控制；沒有 AT execution evidence | DOC | NEEDS_RUNTIME_VERIFICATION |
| F03 手部精度低 | 不靠精細點擊完成 | external client/voice possible | 發送 URL→確認 | 大 target/非精細操作由 client 提供 | repo 僅 stdio；無 client touch evidence | DOC | scope/client runtime UNKNOWN |
| F04 記憶負荷敏感 | 中斷後知道做到哪 | partial write | apply→interrupt→resume | persistent status/next step | 無 durable save receipt；generic error 使狀態難恢復 | SRC | P2 #4 |
| F05 他人協助設定 | 設定後自己日常 exact-link save | preconfigured host | exact URL→preview/apply | 日常不再碰秘密 | daily core 可走 exact path；refresh/auth recovery 仍未 runtime 驗證 | SRC | #3 remains onboarding/recovery blocker |
| G01 keyboard-only | 用 keyboard-capable MCP client 收藏 | external client | type/paste URL→confirm | 全流程 keyboard 可達 | repo 無自有 UI；stdio 可被 keyboard client 使用但未驗證 | DOC | NEEDS_RUNTIME_VERIFICATION |
| G02 screen reader | 聽懂成功/部分失敗 | partial failure | apply→error announced | machine-readable typed state | generic error 不表達 confirmed partial side effect | SRC | P2 #4 |
| G03 色覺限制 | 不靠顏色判斷狀態 | external client | preview/apply→status | status 有文字/結構 | server 回 JSON/text，不依顏色；client presentation 未測 | SRC | positive static；runtime UNKNOWN |
| G04 200% zoom/窄視窗 | 窄畫面完成核心 | external client/mobile-like | exact save | 不因 layout 阻塞 | repo 無 GUI；mobile HTTP layer 尚未提供，client layout 未測 | DOC | scope/client runtime UNKNOWN |
| G05 慢網路/高延遲 | 慢網路仍在有限時間取得結果 | delayed provider | invoke search/save | deadline/cancel/可重試結果 | provider fetch 無 finite deadline/caller abort contract | SRC | **P2 F-05 #6** |
| H01 Windows developer | 安全 setup/run | Windows Node 20 | OAuth→MCP config→tests | token 不進 console；Windows behavior 有證據 | plaintext token handoff；無 Windows runtime | DOC/SRC | P1 #3 |
| H02 macOS developer | 安全 setup/run | macOS Node 20 | OAuth→MCP config | secure credential lifecycle | plaintext token handoff；無 macOS runtime | DOC/SRC | P1 #3 |
| H03 Linux/CI noninteractive | 自動化測試與穩定退出 | CI/stub provider | npm ci/test→MCP request stall | commit-bound gate；timeout bounded | Actions 0；request 無 deadline | GH/SRC | P1 #5 + P2 #6 |
| H04 自架/Cloudflare部署者 | 判斷是否需要服務部署 | repo docs | inspect architecture→run stdio | scope 清楚、不誤稱 cloud deploy | README 明示 local stdio，沒有部署 runtime claim | DOC | no new P0-P2; scope explicit |
| H05 第三方維護者 | 接手後快速驗證 | fresh clone | README→npm ci/test→inspect Issues | canonical gate/known blockers清楚 | tests/issues存在但沒有 CI execution receipt | GH/DOC | P1 #5 |
| I01 重複點擊/重送 | 不重複加同一 exact video | same exact URL twice | save→save again | second detected duplicate | source 有 video-ID dedupe；write timeout 後 retry 安全性仍由 #4 阻塞 | SRC | positive static + P2 #4 for ambiguous retry |
| I02 中途關閉程序 | 恢復未知中的 write | interrupt after create/insert | restart→retry | reconcile provider state before mutation | 無 durable operation key/receipt | SRC | P2 #4 |
| I03 錯誤輸入 | 對 playlist URL/壞 ID 給清楚錯誤 | invalid input | invoke identify/save | fail clearly, no side effect | parsers/Zod 有 source-level validation；未跑 stdio fixture | SRC | no new P0-P2; runtime needed |
| I04 API timeout/429/5xx | 有 bounded timeout/retry/fail-safe | stalled/429/500 provider | invoke request | timeout/cancel typed；retry finite；writes不盲重送 | HTTP errors可 throw，但 transport stall 無 deadline；mutation ambiguity另由 #4 | SRC | **P2 #6** + P2 #4 |
| I05 部分成功後重試 | 不重複建立／盲 insert | create 200 + insert unknown | retry same operation | read-back/reconcile then decide | generic error + 無 operation receipt | SRC | P2 #4 |
| J01 大量資料 | 大 playlist/list 可完成或明確界線 | many playlists/items | list/classify/dedupe | pagination/limits透明、無無限 loop | source有 pagination 與 finite target；超大真實資料未測 | SRC | no new P0-P2; performance runtime needed |
| J02 多使用者/並行 | 同名 playlist 並行 save 不造成衝突 | two concurrent saves | both resolve missing→create/apply | deterministic ownership/idempotency | operation-level concurrency/reconcile 未證明；同根因併入 #4，不另開 duplicate | SRC | P2 #4 |
| J03 長時間連跑/資源耗盡 | provider stall 不拖死長跑 host | never-resolving request | invoke repeatedly/long run | deadline + listener/timer cleanup | 無 request deadline；resource growth 尚未 runtime 測 | SRC | **P2 #6** |
| J04 安全/隱私敏感 | 不讓 OAuth secret 出現在任何 output | OAuth setup/errors | authorize→capture stdout/stderr | zero token leakage | bootstrap 明確印 raw token | SRC/DOC | P1 #3 |
| J05 專家／最短路徑自動化 | 高速 free-text/exact 自動化仍安全 | batch calls | resolve→apply→retry | identity reviewed、bounded、commit gate verified | free-text top1、無 CI、無 timeout bound | SRC/GH | P1 #2 + P1 #5 + P2 #6 |

## 修正後回歸狀態

本輪沒有任何 #2/#3/#4/#5 對應產品修正 merge 到 default branch；`6ffeca21...` 只新增 audit 文件。因此：

- #2：`STILL_REPRODUCIBLE`（source）。
- #3：`STILL_REPRODUCIBLE`（source/docs）。
- #4：`STILL_REPRODUCIBLE`（source）。
- #5：`STILL_REPRODUCIBLE`（GitHub Actions 仍無 run/status receipt）。
- #6：`NEW / CONFIRMED_SOURCE / NEEDS_RUNTIME_VERIFICATION`。

沒有因 Issue 狀態、文件聲稱或 test file 存在而宣稱 runtime fixed。

## Runtime Verification Queue

1. #3：使用 disposable OAuth client/account，在支援 OS 上捕捉 stdout/stderr/MCP output，證明 secret sentinel 為 0，並驗證 revoke/re-auth。
2. #2：使用 bounded disposable input set，驗證 free-text ambiguous cases 不可未審核直接 write；exact provider ID path 不需 search。
3. #4：local stub + disposable private playlist，覆蓋 create-success/insert-403/404/5xx/lost-response/timeout/read-back/retry。
4. #6：real stdio MCP process + local stub server，注入 never-resolving connection、caller abort、delayed success、429、500、refresh stall；量測有限完成時間與 cleanup。
5. #5：恢復／新增 default-branch CI 後，取得 current/recent SHA 上真正 runner execution 的 `npm ci` + canonical deterministic suite + MCP smoke receipt。
6. Accessibility/client：至少一個支援的 MCP client 做 keyboard-only、screen reader、200%/narrow-window；mobile 若產品正式宣告支援時再納入必要 runtime gate。

## 寫入／鎖定／協調

- 建立新 finding 前已搜尋 repo open/closed Issues；timeout/deadline/Abort/cancellation fingerprint 無同根 Issue。#4/#5 雖提到 timeout/CI，但 root cause 分別是 mutation reconciliation 與 CI admission，與 #6 不同。
- 查核 open PR：本輪寫入前為 0；branch 僅 `main`，沒有可視為已落地修正的候選 branch。
- 未修改產品原始碼、CI、Secrets、權限、repository settings，未 merge、未 deploy、未啟動修復代理。
- 既有 #2/#3/#4/#5 未重複留言；本輪固定 persona 對應集中於此報告與 umbrella #7，避免與其他 worker 的 Issue 工作衝突。

## 與上輪差異

此 repository 先前沒有固定 A01–J05 的正式 portfolio round；已有 product-board audit 但 persona 模型不同，不能算固定 50-persona round。此 Round 1 首次建立固定 50-row matrix，去重映射既有 #2–#5，並新增獨立 P2 #6。

## 下一步

修正 landing 後必須使用相同 A01–J05、相同 failure triggers 與 acceptance criteria 重新跑；在所有 P0/P1/P2 gate 關閉／明確 not_planned 且必要 runtime evidence 有效前，不累加 CLEAN streak。Portfolio 輪巡應繼續到尚未完成 discovery／久未檢查的 Reese-max repos，而不是重複掃本 repo 的 audit-only HEAD。
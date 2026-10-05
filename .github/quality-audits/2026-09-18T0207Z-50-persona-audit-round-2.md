# 固定 50-Persona Audit — Round 2

- Round ID: `spotify-playlist-organizer-mcp-R2-20260918T0207Z`
- 稽核規範：`Reese-max/autodev-ng/docs/portfolio-audit/2026-09-06-50-persona-audit.md`
- 固定 persona 規範 blob：`6e3499d6ef5be7e123050e1526946f6a40f99263`
- Issue Quality v2：`Reese-max/autodev-ng/docs/portfolio-audit/2026-09-14-issue-quality-v2.md`
- Issue Quality v2 blob：`8167e10798071d2276addaff6b201c6b0e904a2a`
- Default branch：`main`
- 本輪寫入前 default HEAD：`9b99f580acaf1e0b6631aa911b9222c262ddc1ec`
- 本輪 relevant product SHA：`a0bad36b6ab80185f01f0632f25c8b27ef09dbb8`
- `a0bad36... → 9b99f58...` 比較只有 `.github/quality-audits/2026-09-15T0512Z-product-board-audit.md`；因此 `9b99f58...` 的額外內容視為 audit-only，不當作產品修正或 runtime 證據。
- 固定 umbrella：[#7](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/7)
- 上一完整固定輪次：Round 1，產品 SHA `28589712445e2229d79a1644b360425467ab7404`

> 本報告只使用規範固定的 A01–J05 共 50 個合成人設。這是單一模型的可重複情境推演，不是真人研究、50 票投票或 50 份獨立驗證。產品董事會的動態 persona、競品分數與 feature priority 不替代此基線。

## 結論

**NOT CLEAN — CLEAN streak 0/2。**

本輪是產品變更後的完整固定 A01–J05 **50/50** 複驗，完整輪本身已完成，但**不是 CLEAN-qualified round**：目前仍有適用 P0/P1/P2 tracker／必要 runtime closure 未完成，其中 #8 的 current-default 互動 passphrase echo 根因仍可由 source 確認，且既有 Linux PTY 執行證據已重現；#3、#4、#6 則有實質改善但仍未達各自 closure boundary。缺少必要 runtime 不能用「CI 綠燈」或測試檔存在取代。

本輪**沒有建立新的 distinct P0/P1/P2 fingerprint、沒有確認新的 post-fix regression，也沒有建立新 Issue**。#8 是 2026-09-15 已建立並已有執行證據的既有 finding，不重複通知或重開。多個 active PR 已擁有相關 remediation scope，本輪不搶改。

## Product delta 與現行證據

`a0bad36b6ab80185f01f0632f25c8b27ef09dbb8` 相對 Round 1 產品 baseline `28589712...` 有實質產品改動：

- free-text 收藏改成 preview/identify 後必須綁定使用者選擇的 `videoId` 才能 apply；exact URL/ID 仍保留快速路徑。
- OAuth setup 加入 PKCE、AES-256-GCM 本機加密 credential store、auth status/revoke；不再把 access/refresh token 當成正常 stdout copy/paste 流程。
- provider request 使用有限 deadline、caller cancellation、有限 read retry；ambiguous write 不做 blind retry。
- `youtube_save_track` 已加入 typed partial/unknown write outcome 與 recovery guidance。
- 新增最小 GitHub Actions CI。

### 真實 CI receipt

GitHub Actions run [34923921340](https://github.com/Reese-max/spotify-playlist-organizer-mcp/actions/runs/34923921340) 綁定 exact product SHA `a0bad36b6ab80185f01f0632f25c8b27ef09dbb8`，event=`push`，conclusion=`success`。GitHub-hosted `ubuntu-latest` job `104237768422` 實際完成 checkout、Node setup、`npm ci`、`npm test`；當時 current suite 為 12 tests。這是 CI_EXECUTED 證據，只覆蓋該 suite 實際執行的範圍，**不**等於真實 Google OAuth、YouTube mutation、所有錯誤路徑或支援 OS 都通過。

### Current-main local runtime receipt（既有 #6）

Issue #6 已保存 current default `9b99f580...` 的隔離 Linux / Node v22.16.0 執行證據：對 exact `src/http.js` 共用 primitive 使用 deterministic stub，never-resolving fetch 25 ms → `TIMEOUT` 約 26 ms；caller abort 10 ms → `CALLER_CANCELLED` 約 10 ms；never-resolving body 25 ms → `TIMEOUT` 約 26 ms，assertions 全 PASS，0 provider/paid call。這證明 deadline/cancel primitive，而**沒有**啟動真實 stdio MCP process；因此 #6 仍是 `PARTIALLY_FIXED / NEEDS_RUNTIME_VERIFICATION`，不能以 primitive pass 取代 tool-level closure。

### Current-main security runtime receipt（既有 #8）

Issue #8 已保存 Linux PTY 的 `EXECUTED_REPRODUCTION`：無真實 credential 的 sentinel passphrase 經目前使用的 `readline.question()` primitive 會出現在 captured terminal output。Current default 的 `scripts/youtube-auth.js` 仍用 `readline.question("Credential passphrase (stored locally, never printed): ")`；因此根因仍在。Windows/macOS/MCP host 行為與真實 OAuth 沒有被此證據涵蓋。

## Finding / tracker disposition

| Tracker | Current fixed50 判斷 | 證據邊界 | 本輪處置 |
|---|---|---|---|
| #1 | RESEARCH / policy boundary | Spotify policy/client model visibility 仍是研究問題，不是 current-default 缺陷證據 | 不升級、不實作 |
| #2 | RESEARCH / `severity=NOT_ESTABLISHED`；原 top-1→write 根因已由 explicit `videoId` binding source-addressed | `youtube_save_track` 的 free-text apply 會回 `selection_required`；真實 candidate 品質仍需 runtime/provider evidence | 不恢復舊 P1；不建 duplicate |
| #3 | P1 tracker，**PARTIALLY_FIXED / CANNOT_CLOSE** | raw token stdout/manual handoff 已從 current source 移除，PKCE/加密存放/status/revoke 已存在；但完整 supported-OS credential lifecycle、scope enforcement/zero-secret envelope 與 disposable real OAuth closure 尚未完成。PR #41 正在處理剩餘 scope | `SKIPPED_LOCKED`（active PR #41），不搶改 |
| #4 | P2，**PARTIALLY_FIXED / NEEDS_RUNTIME_VERIFICATION** | typed partial/unknown write source 已落 default；current default 沒有 real stdio handler create-success→insert-fail/lost-response/reconcile regression。PR #36 正在補該 integration fixture | `SKIPPED_LOCKED`（active PR #36），不搶改 |
| #5 | P3 VALIDATION_GAP，明顯改善 | CI workflow 已存在且 exact `a0bad36...` push run 成功；負向 admission proof 等 P3 驗收未全完成 | 不當 P1/P2；不影響本輪 severity 判斷 |
| #6 | P2，**PARTIALLY_FIXED / LOCAL_EXECUTED** | bounded primitive 已實測；真實 stdio MCP + local stub tool-level cancel/timeout/write-no-retry closure 尚缺 | 保持 open；不冒充 complete runtime |
| #8 | P2 BUG，**STILL_REPRODUCIBLE** | current source 仍 `readline.question()`；既有 Linux PTY sentinel 已 EXECUTED_REPRODUCTION。PR #41 有候選 no-echo 修正但未合併 | 不重複 Issue；active remediation 不搶改 |
| #9–#19 等 feature/research trackers | 產品方向/feature backlog | Issue title 的 P0/P1/P2 feature priority 不是固定稽核的 defect severity 證據 | 不把 feature absence 當 current defect |
| #21–#35 中多數 PR #20 branch findings | 非 current default | 對 open PR #20 的候選程式碼／feature branch review，不代表 `main` 現行產品 | 不計入 current-default finding map；PR 未合併不視為修復或回歸 |

## 開單前四道判準複核

- **問題**：current default 真正可到達且仍通過 defect 門檻的是既有 #8；#3/#4/#6 均已有既有追蹤與部分修正證據，不因「還缺某框架」另開單。
- **優先級**：缺 live OAuth、缺完整 stdio integration 或缺負向 CI proof 可以阻止 CLEAN／closure，但不自動變成新的 P1。#8 維持 P2，因為有安全風險與可到達互動 setup 路徑，但沒有證據顯示 credential 已遭取用或帳號事故。
- **最小修正**：#8 只需真正 no-echo input；不能安全 no-echo 的 host fail closed 改用既有 env/secret source。#4/#6 應重用現有 typed receipt/deadline primitives與 local stub，不需 operation database/ledger/service。
- **實作資格**：本 audit 沒有把 Issue existence、severity 或 active PR 當成新的實作授權；未 merge/deploy、未建分支、未啟動 worker。

## 十個測試維度摘要

1. **首次理解/成功**：README 已更清楚描述 identify→selected `videoId`→save；credential setup 仍受 #8 互動 secret echo 影響，real OAuth first-success 未執行。
2. **核心任務**：exact URL/ID 與 selected-video apply 的 source path 可追；CI 覆蓋現有 unit/smoke，但沒有 disposable provider write。
3. **錯誤恢復**：typed partial state 已落 source，#4 所要求 handler/stdio partial-write/lost-response/reconcile 執行證據仍未在 default branch 完成。
4. **資料安全**：token stdout handoff 已改善；加密 store 與 PKCE source-confirmed；#8 passphrase echo 仍是 current defect；Windows/macOS storage semantics仍需驗證。
5. **可觀測性**：typed timeout/cancel/partial results比 Round 1 明顯改善；tool-level integration receipt仍不完整。
6. **無障礙/裝置**：repo 本體主要是 stdio MCP，最終視覺/AT 呈現由 client 決定；CLI 輸入與非互動是適用重點。沒有宣稱 screen-reader/mobile UI pass。
7. **效能/成本**：provider timeout 有有限上限、read retry 有界、write 不 blind retry；沒有真實 quota/長時間 provider load 數據。
8. **維護性**：最小 CI 已實際觸發成功；active PR 很多，但未合併 PR 不算 current product。
9. **失敗注入**：#6 primitive 有 deterministic timeout/cancel 執行；#4 full stdio partial-write fixture仍只在未合併 PR 候選中。
10. **信任**：free-text write 現在要求 explicit selected video ID，部分成功會嘗試保持 truthfulness；secret input 的「never printed」文字與 current TTY 行為仍不一致（#8）。

## 固定 50 Persona × Scenario Matrix

證據縮寫：`SRC`=current default source；`DOC`=current docs；`CI`=exact-SHA GitHub Actions executed；`LOCAL`=隔離本機實測；`ISSUE`=既有 tracker/receipt；`UNKNOWN`=未執行的 provider/OS/client 路徑。每列沿用固定 persona 身分、限制與成功條件；補充測試不替換 Round 1 基線。

| Persona | 目標／前置／輸入 | 核心步驟 | 預期 | 本輪觀察 | 證據 | 結果／Finding |
|---|---|---|---|---|---|---|
| A01 | 新手、手機優先；第一次收藏 exact YouTube URL | 依 README 設定→授權→preview/apply | 不暴露秘密並完成第一次收藏 | 流程文件改善；repo 仍是 stdio，互動 auth passphrase 可回顯；real OAuth 未跑 | DOC/SRC/ISSUE | P2 #8；first-success runtime UNKNOWN |
| A02 | Docs 熟、CLI 生；首次設定 OAuth | 安裝→auth→貼連結→收藏 | 低 CLI 摩擦、秘密不可見 | token copy 已移除、加密 store/PKCE 存在；互動 passphrase 仍 echo | SRC/LOCAL/ISSUE | P2 #8；#3 PARTIALLY_FIXED |
| A03 | 資工學生；改規則後提交 | 改動→push/PR→測試 | commit-bound gate 可重複 | 最小 CI 已存在且 a0bad push run 成功；負向 admission proof未驗 | CI/SRC | #5 P3 改善，不升級 |
| A04 | 時間壓力；只輸入歌名 | identify→候選→apply | 不因省步驟寫入錯版本 | free-text apply 沒有 `videoId` 會 `selection_required`，已阻止舊 top-1 直接寫入 | SRC | 舊 #2 根因 source-addressed；provider品質 UNKNOWN |
| A05 | 依賴清楚狀態；provider 部分失敗 | create→insert failure→看結果 | success/partial/unknown清楚且可恢復 | typed partial/unknown state已落 source；current default缺 handler-level executed fixture | SRC/ISSUE | P2 #4 PARTIALLY_FIXED |
| B01 | 程式陌生；exact URL 收藏 | preview→apply | 簡單且可完成 | exact-ID source path明確；真實 provider mutation未執行 | SRC | NEEDS_RUNTIME_VERIFICATION |
| B02 | 初階工程師；慢網路 | search/save→transport stall | 有界 timeout、可理解錯誤 | deadline primitive已 LOCAL_EXECUTED；stdio tool-level closure缺 | SRC/LOCAL | P2 #6 PARTIALLY_FIXED |
| B03 | 設計師；可逆與恢復 | createIfMissing→insert失敗 | 不隱藏已發生 effect | source 已有 partial receipt；full handler regression未在 default 執行 | SRC/ISSUE | P2 #4 PARTIALLY_FIXED |
| B04 | 研究助理；重視來源 | free-text preview→選候選→apply | 已選 identity 不漂移 | explicit `videoId` binding保留選擇；沒有 live search reorder canary | SRC | #2 NOT_ESTABLISHED / research |
| B05 | 輪班、碎片時間、手機 | 行動端呼叫收藏 | 支援入口不中斷 | current product scope 是 stdio MCP；沒有 current-default mobile UI，不能宣稱 mobile runtime pass | DOC | scope/runtime gap，不新開 defect |
| C01 | 稽核使用者；要追溯 identity/effect | 選定 video→apply→看 receipt | 能說明哪個 ID 寫到哪裡 | exact selected video 與 typed state改善；真實 write receipt未 canary | SRC | #4 runtime gap |
| C02 | 多人低學習成本 | 各自本機設定→日常 exact save | 帳號/流程不混淆 | local stdio定位清楚；多使用者 SaaS 非 current scope，OAuth first-run仍有 #8 | DOC/SRC | P2 #8 applicable |
| C03 | 高風險錯誤防護 | auth→provider error | secrets不出 output，fail-safe | token stdout已移除；passphrase TTY echo已重現；full error-envelope redaction由未合併 PR #41補 | SRC/LOCAL | P2 #8；#3 CANNOT_CLOSE |
| C04 | 長流程不中斷 | create→中斷→retry | 不重建/重加、可安全恢復 | source有 unknown/partial語意；default缺完整 stdio lost-response/reconcile execution | SRC/ISSUE | P2 #4 |
| C05 | SRE；bounded failure | CI→slow request→cancel | admission receipt + finite timeout | CI exact SHA success；deadline/cancel primitive local pass；stdio integration未完成 | CI/LOCAL | P2 #6 PARTIAL |
| D01 | 主管只看摘要 | partial write→讀結果 | 一眼分辨成功/部分/未知 | typed state改善；尚缺 real handler receipt | SRC | P2 #4 runtime gap |
| D02 | PM；追蹤操作責任 | repeated save / recovery | operation狀態與下一步清楚 | exact IDs/partial state source有改善；無 current-default durable operation ledger，且目前沒有證據需要新增大型 ledger | SRC | #4最小 scope；不擴工程 |
| D03 | IT 管理員；部署/憑證 | auth→status/revoke→upgrade | credential lifecycle安全且可診斷 | encrypted store/status/revoke/PKCE存在；supported OS/real revoke未實測；TTY secret echo仍在 | SRC/LOCAL | #3 partial + P2 #8 |
| D04 | 成本敏感 | slow/429/5xx | 有限重試與有限等待 | finite timeout、有限 read retry、write no blind retry source-confirmed；真 provider quota未知 | SRC/LOCAL | #6 partial；cost runtime UNKNOWN |
| D05 | 法遵/稽核 | setup→apply→查 evidence | 不保存裸 secret，狀態可追溯 | credential ciphertext/source改善，但 passphrase可留 terminal capture；provider evidence未完成 | SRC/LOCAL | P2 #8；#3 partial |
| E01 | 傳統辦公、少新式 UI | 依一步步文件收藏 exact link | 少概念負擔、錯誤可恢復 | README two-stage較清楚；仍需 CLI/MCP host setup，real usability未測 | DOC | UNKNOWN usability；不虛構缺陷 |
| E02 | 桌面/大字需求 | 由桌面 MCP client操作 | 文字狀態可讀、不靠精細 UI | server回傳 structured text；最終字體/縮放由 client掌控，無 AT runtime | SRC | client-dependent UNKNOWN |
| E03 | 低數位熟悉度、怕按錯 | preview→apply→取消/錯誤 | 有確認與安全恢復 | preview/apply + selection_required是正面控制；互動 secret提示仍有 #8 | SRC/LOCAL | P2 #8 |
| E04 | Excel 熟、不熟部署 | README setup→local MCP | 不需雲端部署即可成功 | local stdio與本機 credential是既有路徑；real first-run OAuth未執行 | DOC/SRC | NEEDS_RUNTIME_VERIFICATION |
| E05 | 長時間使用 | 多次收藏/失敗後閱讀結果 | 狀態一致、避免無限等待 | bounded request改善長等待；視覺疲勞由 client呈現，無 runtime | SRC/LOCAL | #6 partial；client UX UNKNOWN |
| F01 | 高齡初用 | 由協助者設定後 exact save | 日常操作步驟少 | exact URL可直接 save；setup仍有 CLI/OAuth摩擦且未做 usability runtime | DOC/SRC | UNKNOWN usability |
| F02 | 視力較弱 | 放大 client介面後操作 | 200%縮放仍可完成 | server無自有 GUI；client負責呈現，不能以 source宣稱 pass | SRC | client-dependent UNKNOWN |
| F03 | 手部精度較低 | client點選候選再 apply | 目標可操作、不誤選 | server要求 exact `videoId`，但觸控尺寸由 client決定；無 mobile runtime | SRC | identity guard PASS source；device UNKNOWN |
| F04 | 記憶負荷敏感 | preview→稍後 apply→失敗恢復 | 一步一事、持久清楚 | two-stage選擇與 typed recovery較 Round1改善；handler recovery runtime未全驗 | SRC | P2 #4 partial |
| F05 | 他人協助設定、本人日用 | 完成 OAuth後日常 exact save | 日常不必再處理 secret | encrypted credential/status支援；refresh/revoke real provider未驗 | SRC | #3 partial / runtime gap |
| G01 | keyboard-only | terminal/MCP keyboard workflow | 不需滑鼠即可完成 | stdio/CLI天然可鍵盤操作；OAuth瀏覽器callback仍未做完整 keyboard runtime | DOC/SRC | NEEDS_RUNTIME_VERIFICATION |
| G02 | screen reader | 讀 structured result / recovery | 狀態不只靠視覺 | MCP結果是文字/JSON；client AT呈現未測，partial state source更明確 | SRC | #4 runtime gap；AT UNKNOWN |
| G03 | 色覺限制 | 辨識 success/partial/error | 不只靠顏色 | server typed textual states，不依顏色；client presentation未驗 | SRC | source-positive / client UNKNOWN |
| G04 | 200%縮放/窄視窗 | 由支援 MCP client操作 | 不因窄螢幕失去核心資訊 | server無 current-default Web UI；client-dependent，未執行 | SRC | UNKNOWN，不硬開產品 defect |
| G05 | 慢網路/高延遲 | search/save→stall/timeout | 有限時間返回並可安全重試 | common primitive LOCAL_EXECUTED timeout/cancel；stdio/provider完整路徑仍缺 | LOCAL/SRC | P2 #6 partial |
| H01 | Windows 開發者 | auth/store/status/revoke | 支援平台秘密安全 | POSIX chmod不等同 Windows ACL；實際 Windows store/TTY未驗 | SRC | #3/#8 NEEDS_RUNTIME |
| H02 | macOS 開發者 | auth/store/status/revoke | 同上且不回顯 passphrase | encryption source有；macOS TTY/permissions未執行 | SRC | #3/#8 NEEDS_RUNTIME |
| H03 | Linux/CI 非互動 | 無 TTY 啟動 server/test | fail closed、有限時間、CI可重複 | CI exact SHA成功；non-TTY passphrase缺失會 fail closed；deadline local pass | CI/SRC/LOCAL | positive coverage；#6 tool-level仍缺 |
| H04 | 自架/部署者 | 設定 env→運行 stdio host | secrets不進 repo/log，邊界清楚 | local-first scope；無 current hosted deployment contract，不把未支援部署當缺陷 | DOC/SRC | scope boundary |
| H05 | 第三方維護者 | README→tests→CI→issue/PR | 能辨識 current default與未合併候選 | CI、README、Issue已有；大量 open PR不算 current product，active scopes已避讓 | DOC/CI/GH | maintainability improved |
| I01 | 重複點擊/重送 | 同一 exact video重送 | 不重複 effect | exact-ID duplicate path source存在；ambiguous/lost response reconciliation default handler未完整 executed | SRC | P2 #4 runtime gap |
| I02 | 中途關程序後恢復 | OAuth/store或 write中斷→restart | 已確認狀態可恢復 | encrypted credentials持久；write recovery receipt非 durable service ledger但目前最小策略是 exact-ID read-back；完整 stdio fixture未落 default | SRC | #4 partial，不擴大型 ledger |
| I03 | 錯誤輸入 | playlist URL當track、無效ID/文字 | fail clearly且不寫入 | parsers/schema/source有明確拒絕路徑；CI suite通過其現有覆蓋 | SRC/CI | no new P0/P1/P2 |
| I04 | timeout/429/5xx | provider故障 | 有界、typed、有限 retry；write不blind retry | shared primitive local pass；read retry source有界；真 stdio/provider仍未 closure | SRC/LOCAL | P2 #6 partial |
| I05 | 部分成功後重試 | create success→insert unknown→retry | 先核對 exact state再決定 | typed `UNKNOWN_AFTER_WRITE`/partial source已落；PR #36有候選 executed suite但未 merge，不能算 current evidence | SRC/GH | P2 #4 partial |
| J01 | 大量資料 | 多 playlist items / batch reads | 有界分頁、避免無限資源 | provider client有 bounded request/retry；未做大型真實 provider load | SRC | performance runtime UNKNOWN |
| J02 | 多使用者/並行 | 多 MCP呼叫同時操作 | 不因並行破壞已授權 effect | current local single-user scope；並行 provider mutation完整 reconciliation未實測，沒有 current defect reproduction | SRC | NEEDS_RUNTIME；不捏造 P1/P2 |
| J03 | 長時間連跑 | 反覆 timeout/retry | 不洩漏 timer/listener/無限等待 | shared primitive finally清 timer/listener；短 deterministic fixture pass，長跑資源量測未做 | SRC/LOCAL | #6 partial / long-run UNKNOWN |
| J04 | 安全/隱私敏感 | OAuth→status/revoke→查看 output | 0 secret exposure | token stdout改善，但互動 passphrase echo已重現；full envelope redaction候選在未合併 PR #41 | SRC/LOCAL | P2 #8；#3 partial |
| J05 | 專家、自動化最短路徑 | exact ID/noninteractive→cancel/retry | 可用明確 IDs、signal、typed receipt自動化 | exact ID與 signal propagation source改善；real stdio timeout/partial integration仍未 closure | SRC/LOCAL | #4/#6 partial |

## Round qualification / CLEAN

- 固定 persona 覆蓋：**50/50 complete**。
- 新 distinct P0/P1/P2：**0**。
- 新確認 regression：**0**。
- Existing current-default defect：#8 P2 `STILL_REPRODUCIBLE`；#3/#4/#6 尚未達 closure。
- 必要 runtime：**不完整**（real/disposable OAuth + supported OS credential behavior、current-default stdio partial-write reconciliation、current-default stdio timeout/cancel tool path；真實 provider mutation只有在授權安全 canary下才能聲稱）。
- Qualifying CLEAN round：**NO**。
- Consecutive qualifying rounds：**0/2**。
- Repo status：**NOT CLEAN**。

## Coordination / safety

本輪在作出 tracker disposition 前已重新讀取所有狀態 Issues、open PRs，並讀取 #3/#4/#6/#7/#8 的完整 comments。可見歷史 audit/runtime leases 均已有 matching release。Active PR #41 擁有 #3 且覆蓋 #8 no-echo scope；PR #36 擁有 #4 integration fixture；PR #20 與其 stacked PRs擁有尚未落 default 的 v0.3 feature/review scope。本輪因此不修改這些 active implementation scopes，也不把 PR head 當 current default。

沒有修改產品原始碼、CI/config、secrets、權限/settings；沒有建立 implementation branch、merge、deploy、啟動 worker/GOAL、呼叫真實 YouTube/Spotify mutation或新增付費承諾。

## 下一步證據（不代表授權實作）

1. 等候或核對 #41 真正進 default branch後，以 #8 同一 sentinel/PTY 成功條件重跑，並分別記 Windows/macOS/Linux 支援界線；未 merge 前不給 VERIFIED_FIXED。
2. 等候或核對 #36 真正進 default branch後，以 real stdio MCP + local HTTP stub 重跑 create-success/add-fail、lost response、read-back/retry；沒有 provider write。
3. 對 #6 以具 dependencies 的隔離環境跑 real stdio MCP + local stub 的 timeout/cancel/finite retry/write-no-second-mutation；保留現有 primitive receipt，不重做為大型 framework。
4. 若進行 disposable Google OAuth canary，必須用非正式帳號/低風險環境並完整 redaction；沒有這種安全授權時維持 `NEEDS_RUNTIME_VERIFICATION`，不以缺 canary 製造新缺陷。

# Issue #3 本機驗收

基準：`cbfbb0431a0041b084953b2d86e346dd764129d7`，僅修改 `issue-loop/issue-3`。
先執行新回歸測試，14 項中 11 項失敗：scope 未拒絕、`READY` 誤報及秘密輸出；其後才實作修正。

| 驗收條件 | 本機證據／限制 |
| --- | --- |
| setup stdout/stderr 無 token、client secret、code | 假 OAuth 子程序擷取成功、拒絕、endpoint 與 network 失敗；瀏覽器回應亦檢查哨兵。 |
| 安全持久化 | 沿用 scrypt + AES-256-GCM；加密檔不含明文哨兵，POSIX 測試檢查 0600。真實 OS ACL 尚未驗收。 |
| Desktop PKCE | 真實 loopback callback，檢查 S256 challenge 等於 token exchange verifier 的 SHA-256。未連 Google。 |
| scopes fail closed | setup 拒絕缺少／空白／readonly；既有憑證與 refresh 拒絕縮減／空白授權。失敗不持久化、不快取、不呼叫後續 API；省略 scope 的 refresh 只沿用同一 token 的已知授權。 |
| status 五態且無秘密 | READY／EXPIRED／REVOKED／MISSING／UNKNOWN；未知 expiry 保留 null，環境 fallback 附警示。 |
| revoke 與復原 | 假 endpoint 成功／invalid_token 後刪除加密檔，其他失敗保留檔案；invalid_grant 清除同一授權的 token 並保存可刪除的撤銷標記，不破壞另一組已存授權。重新授權可取代快取，輪替後使用新 token，撤銷後在途讀取／refresh 不能恢復憑證。 |
| README／.env.example | 說明加密 store、passphrase、檔案權限、重新授權與明確開發 fallback，無終端 token 複製步驟。 |
| MCP／錯誤遮罩 | 共用輸出入口遮罩巢狀成功與錯誤欄位；含環境、file-only、輪替／trimmed token、provider error body，以及 client 環境隔離。transport error 的原始 cause 可能含 request 秘密，因此以固定安全 cause 取代，保留錯誤代碼與 retryable。 |
| exact-link／search／playlist | 保留並執行現有 stdio E2E、YouTube provider 與全套件，包含既有 preview／apply／read-back 行為。 |

測試使用合成憑證、隔離暫存目錄與假 OAuth endpoint；沒有讀取真實帳號或執行實際 provider 寫入。
未完成：拋棄式 Google 帳號的實際 PKCE／refresh／revoke／重新授權、支援 OS 的使用者權限／ACL，以及實際 MCP host 的輸出擷取。未新增帳號 fingerprint 查詢或 OS Keychain adapter；現有加密 store 足以承接本機程式修正，但不代表這些 runtime 驗收已通過。
Mutation 為專案週期性檢查，本次不執行；不 push、不開 PR、不關 issue、不 merge，交由 driver 處理。

修改範圍：`src/credentials.js`／`src/youtube.js` 沿用既有 store 與 client 補齊授權生命週期；`src/library.js`／`src/server.js` 共用既有遮罩規則；`src/http.js` 移除秘密診斷 cause；`scripts/youtube-auth.js` 固定安全訊息。`test/youtube-security.test.js` 提供安全回歸測試，`test/youtube.test.js` 更新既有預期；README 與 `.env.example` 說明行為與限制。沒有新增 runtime 依賴或改動 SQLite schema。

最終驗證（Windows，Node v26.7.0）：案例數由 302 增至 331，新增 29 項安全回歸測試。最後審查的撤銷期間 reload 案例亦先取得 1 fail，再修正至 green。

| 指令 | 結束碼 | 關鍵結果 |
| --- | --- | --- |
| `npm test`（實際以 Git Bash `bash -lc` 執行） | 0 | 331 項；328 pass、0 fail、3 skip。略過的是現有 Linux-only PTY 測試。 |
| `npm run lint` | 0 | 無 ESLint 錯誤。 |
| `npm run test:coverage` | 0 | 同樣 328 pass／0 fail／3 skip；行 93.34%、分支 85.13%、函數 91.62%，通過既有棘輪。 |
| `npm run crap` | 0 | 完成 620 個函數的報表，未新增 CRAP gate；最高項為既有 server 註冊 handler，2162。 |
| `python scripts/test-hidden-input-terminal.py` | 0 | Windows ConPTY 11 項離線控制通過，偵測器正向控制可見，隱藏輸入哨兵無外洩，恢復 cooked visible echo；未證明每個 console flag 均還原。 |
| `git diff --check` | 0 | 無 whitespace 錯誤。 |

本機合成測試通過不等於實際 OAuth／ACL／MCP host 驗收通過；本 issue 的 runtime acceptance 仍待維護者完成。

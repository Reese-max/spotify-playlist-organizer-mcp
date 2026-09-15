# Product Board Audit — Music Playlist Organizer MCP

- Audit time: 2026-09-15T05:12Z
- Repository: `Reese-max/spotify-playlist-organizer-mcp`
- Default branch / inspected product SHA: `main@a0bad36b6ab80185f01f0632f25c8b27ef09dbb8`
- Previous product baseline: `28589712445e2229d79a1644b360425467ab7404`
- Issue Quality v2 blob: `8167e10798071d2276addaff6b201c6b0e904a2a`
- Audit type: product-change regression verification plus board refresh
- Model disclosure: the board and personas below are one model's structured simulation, not independent experts or human research.

## Executive outcome

**INVEST / SIMPLIFY.** The change materially improves the YouTube-first local workflow: PKCE, encrypted local credentials, typed auth status/revoke, finite provider deadlines, read-only retries, non-retried writes, structured partial-effect receipts and default-branch CI are now present. The actual push run [34923921340](https://github.com/Reese-max/spotify-playlist-organizer-mcp/actions/runs/34923921340) executed `npm ci` and all 12 current tests on `a0bad36b` with a read-only GitHub token.

The change is not fully verified against the original acceptance boundaries. The suite has no true `youtube_save_track` handler/stdio regression for create-success/insert-failure/response-loss/reconciliation, no disposable real OAuth run, and no supported-OS credential-store/ACL receipt. A new executable regression was found: when `YOUTUBE_CREDENTIAL_PASSPHRASE` is absent, `scripts/youtube-auth.js` uses `readline.question`; the supplied passphrase is visibly echoed by a normal TTY even though the prompt says “never printed”. This is tracked by [#8](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/8).

CEO three choices:

1. Remove the passphrase echo and finish disposable OAuth/OS-store verification.
2. Add the missing handler-level partial-write and reconciliation tests.
3. Prove CI catches a controlled failing test, then keep the minimal gate.

Do not build hosted transfer SaaS, social discovery, AI recommendations, a native app, subscriptions, or more providers before the local YouTube mutation contract is trustworthy.

## Discovery and change evidence

Portfolio inventory was re-enumerated: 42 owned repositories, 39 unarchived and 3 archived. This report is a formal deep round only for this repository; it does not claim a complete portfolio re-audit or CLEAN result.

Repository state at decision time:

- Unarchived, public, default branch `main`; Issues enabled.
- Open PR search: none.
- Branch inventory: `main` only.
- Existing Issues and all comments for #3, #4 and #5 were read; all historical `github-issue-lock:v1` leases were released.
- No repository `owner-*`, `heartbeat` or active lock marker was found for the new passphrase root cause.
- Product commit [a0bad36b](https://github.com/Reese-max/spotify-playlist-organizer-mcp/commit/a0bad36b6ab80185f01f0632f25c8b27ef09dbb8) changed source, tests, README, env example and CI; this is not audit-only.
- CI run [34923921340](https://github.com/Reese-max/spotify-playlist-organizer-mcp/actions/runs/34923921340), job `104237768422`, 2026-09-15T03:09Z, Ubuntu 24.04, configured Node `20.20.2`, npm `10.8.2`: `npm ci` succeeded, 12/12 tests passed, zero failed/skipped.
- GitHub forced the implementation runtime of `actions/checkout@v4` and `actions/setup-node@v4` from deprecated Node 20 to Node 24. This is a maintenance signal, not evidence that the product tests failed.
- Source test directory contains five files: core, credentials, HTTP, MCP initialize smoke and YouTube client tests. It contains no server-handler regression for the typed partial-write contract.
- Isolated execution, 2026-09-15T05:01Z, Node `v24.19.0`, no real credentials/provider calls: a minimal `readline/promises` PTY fixture echoed `SENTINEL-PASSPHRASE` and then returned length 19. This covers the terminal primitive used by `scripts/youtube-auth.js`; other operating systems and hosts remain unverified.

Evidence levels:

- `SOURCE_CONFIRMED`: PKCE, local loopback validation, AES-256-GCM file, status/revoke, timeout/cancel, bounded read retry, no write retry, typed mutation receipt, CI workflow, and echoed-input call site.
- `EXECUTED_REPRODUCTION`: Linux PTY passphrase echo.
- `CI_EXECUTED`: current 12-test suite and MCP initialize smoke at the inspected SHA.
- `UNKNOWN`: disposable Google OAuth callback, revocation and refresh; Windows/macOS ACL and terminal behavior; real YouTube visibility/latency; lost-response reconciliation; negative CI admission proof.

## Product scope and north star

Serve a privacy-conscious person or small technical team that wants a local, inspectable assistant to identify a YouTube/YouTube Music track, preview the exact candidate, classify it deterministically, avoid exact-ID duplicates and apply one recoverable playlist mutation.

North-star task: **from a user-confirmed video ID to a truthful, bounded and recoverable playlist result without exposing credentials or guessing whether a write happened.**

The durable differentiator is not catalog breadth. It is a local MCP control surface with preview-first intent, exact identities, non-secret receipts and explicit uncertainty.

## External market check

Checked 2026-09-15. Public pages do not expose reliable effect-size data; capability statements are `CONFIRMED` only for what the pages describe, not for implementation quality or user outcomes.

| Alternative | Evidence | Confirmed capability / boundary | Implication |
|---|---|---|---|
| YouTube Music | [official playlist help](https://support.google.com/youtubemusic/answer/7205933) | Native create/add/edit, privacy and collaboration across YouTube surfaces; update date not shown | MUST MATCH a clear selected destination and visible mutation result; do not copy consumer-social breadth |
| YouTube Data API | [playlists.insert](https://developers.google.com/youtube/v3/docs/playlists/insert), [playlistItems.insert](https://developers.google.com/youtube/v3/docs/playlistItems/insert) | Playlist creation and item insertion are separate write operations | MUST MATCH truthful partial-effect reporting and exact-ID reconciliation |
| Google OAuth | [best practices](https://developers.google.com/identity/protocols/oauth2/resources/best-practices) | Secure token storage, revocation/deletion and installed-app protections | MUST MATCH zero-secret output; passphrase is secret material too |
| Soundiiz | [official site](https://soundiiz.com/) | Web transfer/sync/merge/export, match report; free one-playlist-at-a-time up to 200 selected tracks; page displayed 2026 content | SHOULD BE BETTER at local inspectability and single-effect truth; do not copy multi-account SaaS |
| TuneMyMusic | [official site](https://www.tunemymusic.com/) | Cross-service transfer/sync/backup/share and dashboard; vendor says it uses official APIs | Market signal for bulk migration, not evidence this product needs bulk hosted transfer |
| Manual YouTube/API script | [YouTube API docs](https://developers.google.com/youtube/v3/) | Maximum control, but auth, matching, retries and recovery are assembled by the operator | DIFFERENTIATOR: safer defaults and typed receipts without hiding exact provider IDs |

Strategic categories:

- **MUST MATCH:** secure credential entry/storage; explicit destination and exact candidate; bounded requests; no blind retry of ambiguous writes; truthful partial state.
- **SHOULD BE BETTER:** local-first privacy, preview/apply separation, exact IDs, concise recovery guidance, inspectable failure states.
- **DIFFERENTIATOR:** deterministic classification plus an MCP-native, reversible-by-human workflow that says `UNKNOWN_AFTER_WRITE` when uncertainty is real.
- **DO NOT COPY:** hosted account aggregation, continuous cross-service sync, social feeds, AI taste generation, subscriptions, marketplace, bulk-provider matrix.

## Product board — structured multi-perspective simulation

- **CEO:** fund only credential closure, mutation truth and CI admission. Provider expansion is a distraction.
- **CPO:** the first-success promise is one confirmed track safely saved; onboarding and recovery are part of that promise.
- **CTO:** current primitives are appropriately small. Do not add a ledger until exact-ID read-back proves the stateless approach insufficient.
- **Staff/Principal Engineer:** #4 is source-improved but unverified at the actual handler boundary; client unit tests cannot close orchestration semantics.
- **UX Lead:** typed states help, but recovery text must show the exact playlist/video and a single safe next action.
- **UX Researcher:** synthetic cases predict trust loss around ambiguous writes and visible secrets; real usability evidence is still absent.
- **Growth:** trust and successful first save are more valuable than “supports many providers”; avoid claiming reliability from 12 mocked tests.
- **CFO:** keep provider calls bounded and hosted costs at zero; do not introduce a credential service.
- **Security/Privacy:** encrypted-at-rest tokens are progress, but a visible decryption passphrase violates the same secret-surface principle.
- **QA:** add PTY secret-redaction, handler partial-success, lost-response, exact-ID retry and a controlled CI-failure fixture.
- **SRE:** timeout/cancel and read retry are promising; runtime evidence is still needed for callback, provider latency and actual reconciliation.
- **Accessibility:** CLI messages should not rely on color or ephemeral cursor behavior; no screen-reader defect is claimed without runtime testing.
- **Support:** expose `READY|EXPIRED|REVOKED|MISSING|UNKNOWN`, exact IDs and copy-safe diagnostics with zero secrets.

Minority view: the environment-variable-only workaround is enough for technical users. Red-team conclusion: it is a safe immediate fallback, but it does not excuse offering an interactive path whose explicit “never printed” promise is false.

## 50 synthetic personas

Thirty cases retain the previous regression baseline; twenty explore the changed paths. These are simulations, separate from fixed A01–J05 audits and not eligible to establish CLEAN, incidence, revenue or market share.

| ID | Background / constraint | Goal / expectation | Core task / journey | Friction and result | Recommendation / evidence |
|---|---|---|---|---|---|
| B01 | YouTube-first developer | Save exact link privately | preview → apply | PASS in source; provider runtime unknown | retain exact-ID path |
| B02 | Search-by-title novice | Confirm the right version | search → choose videoId | improved selection-required guard | keep two-step UX |
| B03 | Unstable Wi-Fi user | Recover after insert failure | create → insert disconnect | typed state added; handler test absent | #4 runtime fixture |
| B04 | Shared-terminal user | No visible secrets | interactive auth | FAIL: passphrase echoes | #8 |
| B05 | CI/container user | Non-interactive setup | env secret → auth | fails closed without env; no OAuth runtime | document secret-manager path |
| B06 | Privacy-focused user | Local tokens only | consent → encrypted file | source improved; ACL unverified | #3 OS verification |
| B07 | Revoking user | Remove access clearly | auth revoke | source/test incomplete for real Google | #3 disposable revoke |
| B08 | Expired-token user | Recover without guesswork | status → refresh | typed status exists; live refresh unknown | retain NEEDS_RUNTIME |
| B09 | Playlist curator | Avoid exact duplicate | inspect → add | client test covers exact duplicate helpers | preserve ID dedupe |
| B10 | Long-playlist owner | Predictable completion | list many items | bounded requests; provider pagination runtime unknown | measure without expanding scope |
| B11 | Screen-sharing novice | Safe guided setup | prompt passphrase | FAIL: secret visible | #8 |
| B12 | SSH operator | No scrollback secret | remote TTY auth | FAIL likely on echoing TTY; host untested | fail closed or masked input |
| B13 | Windows user | User-only store | save encrypted file | POSIX chmod catch means ACL unknown | #3 Windows verification |
| B14 | macOS user | Key-safe local setup | save/revoke | encrypted file source only; TTY/permissions untested | #3/#8 runtime |
| B15 | Linux desktop user | Fast first success | local loopback PKCE | source present; callback untested | disposable OAuth |
| B16 | MCP host operator | Bounded call | search during stall | timeout unit passes | add stdio stub |
| B17 | Canceling client | Stop active request | caller abort | unit test passes | keep propagation |
| B18 | Rate-limited user | No retry storm | 429 on read | finite retry unit passes | runtime telemetry later |
| B19 | Mutation user | No duplicate writes | 503 after POST | no auto-retry in source | #4 read-back test |
| B20 | Support engineer | Safe diagnostic | inspect error/status | tokens absent from tested ciphertext only | expand redaction tests |
| B21 | Category-rule editor | Deterministic placement | classify preview | baseline tests pass | no AI classifier needed |
| B22 | Legacy Spotify user | Existing tools continue | search/classify Spotify | current CI has only core coverage | avoid claiming full provider parity |
| B23 | YouTube-only user | Ignore Spotify config | start server | MCP initialize passes | preserve optional legacy path |
| B24 | Private-playlist user | Private by default | create category list | source default private | verify provider response |
| B25 | Public-playlist user | Explicit privacy choice | apply public | reachable but no live verification | preserve explicit enum |
| B26 | Free-text user | Avoid wrong top result | apply raw query | selection_required in source | add handler test |
| B27 | Exact-link user | One-step save | apply URL | source reachable | provider test pending |
| B28 | Existing-playlist user | Never create namesake | resolve exact target | source uses loaded ID | #4 exact-ID retry |
| B29 | Missing-playlist user | Understand createIfMissing=false | apply | generic throw path remains | ensure safeTool clarity |
| B30 | Offline user | Clear network failure | provider unavailable | typed timeout/network layers | actual stdio output pending |
| E01 | Terminal recorder user | No captured passphrase | interactive setup recording | reproduced exposure | #8 zero-echo fixture |
| E02 | Pair-programming team | Share screen safely | auth during support | exposed passphrase risk | env-only temporary path |
| E03 | Ephemeral dev container | Persist credential intentionally | restart container | path semantics documented only | keep local scope explicit |
| E04 | Wrong-passphrase user | Safe recovery | load credential | unit rejects correctly | improve typed UX, no data reset |
| E05 | Rotating-passphrase user | Change encryption secret | rekey | capability absent; demand unproven | evidence backlog, no issue |
| E06 | Multi-account user | Pick account | consent twice | account fingerprint not verified | narrow research only |
| E07 | Supervised account | Respect provider restrictions | save playlist | official restrictions vary | provider error must remain truthful |
| E08 | Brand-account manager | Understand permissions | create playlist | YouTube role behavior untested | runtime backlog |
| E09 | Accessibility CLI user | Hear secret-safe prompts | screen reader + TTY | no AT test; do not claim defect | runtime backlog |
| E10 | Low-vision terminal user | Clear states without color | auth/status | text states present | verify only if supported |
| E11 | Automation author | Machine-readable receipt | stdio apply | typed source result, no contract test | #4 |
| E12 | Interrupted callback user | Resume safely | consent then process exit | recovery path untested | #3 runtime |
| E13 | Revoked-consent user | Reauthorize cleanly | status → auth | real invalid_grant absent | #3 |
| E14 | Quota-constrained user | Know if write attempted | HTTP 429 | `UNKNOWN_AFTER_WRITE` source | handler fixture |
| E15 | Timeout-after-success user | Avoid duplicate | lost response → retry | instruction exists; read-back flow unproven | #4 |
| E16 | Malicious-title user | No log/control injection | provider title in receipt | not evaluated | bounded security backlog |
| E17 | Locked-down enterprise shell | No interactive prompt | env injected by manager | supported workaround | document fail-closed |
| E18 | Secret-scanner operator | No sentinel leaks | test captures artifacts | current tests only ciphertext | #3/#8 tests |
| E19 | Maintainer | CI catches regressions | push bad test | positive run only | #5 negative proof |
| E20 | Minimalist operator | Avoid new infrastructure | local single-user setup | design remains local | keep SIMPLIFY |

Synthetic preference share after reading the changed scope: YouTube Music 32%, this product 28%, Soundiiz 16%, TuneMyMusic 12%, manual/API scripts 8%, IFTTT-like automation 4%. Pure simulation only; it is not a survey, market share, conversion estimate or priority evidence.

## Red Team

1. **“The security issue is fixed because tokens are encrypted.”** Rejected. The new passphrase becomes decryption material and is echoed on the supported interactive path.
2. **“The CI is green, so all fixes are verified.”** Rejected. The actual run is valuable but its 12 tests do not invoke the partial-write handler scenarios or a real OAuth flow.
3. **“Create a credential service.”** Rejected. Environment secrets plus a correctly masked/fail-closed local path solve the observed root without hosted identity.
4. **“Create an operation ledger.”** Deferred. Exact IDs, typed states and read-back may be sufficient; prove insufficiency before adding persistence.
5. **“Retry the write automatically.”** Rejected. A lost response can follow a successful provider mutation.
6. **“Close #4 because source returns `PARTIAL_PLAYLIST_CREATED`.”** Rejected. No true handler/stdio fixture covers the source branch.
7. **“Keep #8 inside #3 to reduce Issue count.”** Rejected. The original root was raw bearer-token printing; #8 is a distinct regression in secret input echo with its own small fix/test.
8. **“The prompt only matters on Linux.”** Not established. Linux PTY is reproduced; Windows/macOS/hosts remain runtime pending, not assumed safe or broken.
9. **“The GitHub action deprecation warning is a P1.”** Rejected. Product Node 20.20.2 tests passed; action-runtime maintenance has no demonstrated core failure.
10. **“Add every competitor provider.”** Rejected as feature bloat and outside the YouTube-first north star.
11. **“The provider is proven reliable by mocks.”** Rejected. Mocks cover code decisions, not Google authorization, quota, visibility or latency.
12. **“Synthetic preference proves product-market fit.”** Rejected. It is explicitly non-human simulation.

## Findings and Issue mapping

| Finding | Kind / severity | Evidence | Status / triage | Tracking |
|---|---|---|---|---|
| F-01 OAuth tokens no longer printed; PKCE/encrypted file/status/revoke added | SECURITY / P1 historical root | source + CI unit | `PARTIALLY_FIXED`; OS/OAuth runtime pending; `NEEDS_REVIEW` | [#3](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/3) |
| F-02 partial mutation states added but true orchestration/reconciliation scenarios unexecuted | BUG / P2 | source; test gap confirmed | `PARTIALLY_FIXED / NEEDS_RUNTIME_VERIFICATION` | [#4](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/4) |
| F-03 default-branch CI now executes the suite | VALIDATION_GAP / P3 after calibration | run 34923921340 | root fixed; negative gate proof pending, so `PARTIALLY_FIXED` | [#5](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/5) |
| F-04 interactive credential passphrase visibly echoes | BUG / P2 | source + executed Linux PTY reproduction | `STILL_REPRODUCIBLE / NEEDS_REVIEW`, auto=false | [#8](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/8) |

The existing [#6](https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/6) timeout/cancellation root is source-improved and unit-tested, but a real stdio local-stub path remains pending. Research #1/#2 and any other active scopes were not rewritten.

## NOW / NEXT / LATER / DON'T

- **NOW:** #8 no-echo/fail-closed input; #4 handler-level partial/unknown/retry fixtures; finish #3 disposable OAuth and host-safe secret capture.
- **NEXT:** negative CI admission proof for #5; local-stub stdio timeout/cancel verification for #6.
- **LATER:** measure real matching/visibility only with authorized low-risk provider fixtures; decide whether account fingerprint/rekey has real demand.
- **DON'T:** hosted auth, automatic blind write retry, universal ledger/framework, bulk provider expansion, AI recommendations, social/community, subscription or native app.

## Decision memo

Serve technically capable YouTube-first users who value local control and truth about side effects. Compete on inspectability, bounded execution and exact reconciliation rather than provider count. The next three priorities are secret-safe onboarding, handler-level mutation truth, and executable admission evidence. Maintain the local/single-user distribution boundary; simplify error and recovery states; pause provider expansion. Recommended portfolio action for this product: **INVEST / SIMPLIFY**. This is advice, not implementation, merge, deployment or spending authorization.

## Accounting and limits

- Total quality findings in this round: 4
- New Issues: 1 — #8
- Updated Issues: 0
- Reopened Issues: 0
- Research Issues created: 0
- Duplicate avoided: 11 opportunity/symptom groups retained in #1/#2/#3/#4/#5/#6 or evidence backlog
- Scope narrowed / severity calibrated: 2 — CI remains validation work; green mocks do not close provider/runtime claims
- Verified fixed: 0 strict closures; three prior roots are materially improved but retain explicit missing acceptance evidence
- Issue write blocked: 0
- Report write blocked: 0 at authoring time
- SKIPPED_LOCKED: taichung-police-intel #20 was not modified because related publication branches/PR #11 and ownership were active/unclear
- Rejected/deferred: 12 Red Team proposals above
- Finding mapping: 4/4
- P0: 0; P1 historical partial: 1; P2: 2; P3 validation partial: 1
- Runtime pending: OAuth callback/revoke/refresh, supported OS permissions and TTY behavior, provider-visible mutation/reconciliation, negative CI admission, screen-reader/keyboard host paths
- CLEAN: not claimed; fixed A01–J05 two-round and runtime stop conditions were not executed by this board simulation.

# Product Board Audit — 2026-09-14 16:10 Asia/Taipei

> Evidence baseline: default-branch commit 28589712445e2229d79a1644b360425467ab7404.  
> All persona and preference results below are synthetic simulations, not interviews, telemetry, market share, or real user testing. No real browser, CLI, OAuth, YouTube API, assistive-technology, or production-account test was performed.

## Executive Summary

spotify-playlist-organizer-mcp is a new local stdio MCP server (v0.2.0) that changed from Spotify-first to YouTube/YouTube Music-first on 2026-09-14. Its strongest product shape is not a general playlist-transfer service: it is a small, local intent-to-playlist broker that accepts a link or search intent, classifies it deterministically, previews the target, deduplicates exact video IDs, and performs an explicit apply.

Three new root findings passed the Quality Gate:

1. P1 SECURITY — the OAuth bootstrap prints raw access and refresh tokens to terminal output (#3).
2. P2 RELIABILITY — create-if-missing is a two-write operation whose partial state is collapsed into a generic error (#4).
3. P1 RELIABILITY/TECH_DEBT — executable tests and a lockfile exist, but default-branch CI has no workflow, run, or status receipt (#5).

A fourth high-value identity-resolution finding appeared concurrently as open Research Issue #2 while this audit was running. It owns top-1 free-text matching and review-before-write, so this audit did not duplicate or modify it.

Decision: INVEST / SIMPLIFY. The product should become a trustworthy, local YouTube playlist effect broker with exact identity, explicit approval, secure credentials, typed mutation receipts, and commit-bound tests. It should not become a hosted cross-service transfer SaaS, social playlist network, recommendation engine, or mobile app.

CEO three things only:

1. Remove plaintext credential handoff (#3).
2. Make every write resolution- and receipt-bound (#2, then #4).
3. Establish an actually executing default-branch gate (#5).

Do not add providers, hosted accounts, recommendation AI, or UI breadth before these controls are verified.

## Project Discovery

### Product type, maturity, user, job

| Dimension | Assessment | Evidence |
|---|---|---|
| Product | Local stdio MCP playlist organizer | CONFIRMED: README, package metadata, server registration |
| Maturity | Prototype / early alpha; two commits on 2026-09-14 | CONFIRMED: commit history |
| Primary user | Technical YouTube/YouTube Music user using an MCP-capable assistant | LIKELY from setup and tool surface |
| Core job | Resolve a song/video, classify it, preview, avoid exact duplicates, and save to a private/category playlist | CONFIRMED: youtube_save_track and README |
| Value | One-step intent-to-playlist organization with local control and deterministic categories | CONFIRMED/LIKELY |
| Main weakness | Trust boundary is behind feature surface: plaintext bearer tokens, unbound resolution/write receipts, no commit-bound gate | CONFIRMED statically |
| Runtime state | Real OAuth, API quota, playlist mutation, read-back, assistive technology, slow network, and OS credential storage | UNKNOWN / Runtime required |

### Repository evidence

- CONFIRMED — Node 20+, ESM, package-lock v3, @modelcontextprotocol/server 2.0.0 and Zod 4.6.5.
- CONFIRMED — npm test runs node --test; npm run smoke runs the MCP initialization test.
- CONFIRMED — YouTube tools cover search, identity, link resolution, list/create playlist, exact-ID duplicate check, classification, add, and save.
- CONFIRMED — preview is the default for youtube_add_to_playlist and youtube_save_track.
- CONFIRMED — free text selects search.videos[0]; exact URLs/IDs use provider identity.
- CONFIRMED — missing target playlist is created before a separate playlistItems.insert call.
- CONFIRMED — OAuth state is random and validated; this is a positive control.
- CONFIRMED — OAuth setup prints access and refresh tokens to stdout and README asks the user to copy them.
- CONFIRMED — no open PR, only main branch at pre-write and audit-write checks.
- CONFIRMED — no workflow run or commit status for the audited head.
- UNKNOWN — tests pass locally; this audit did not execute the repository.
- UNKNOWN — current YouTube quota, API availability, match quality, token compromise, or user-visible incident.

### Recent activity, Issues, PRs, Actions, tests, docs, audits

- Commits: 87c42846 initial Spotify MCP; 28589712 YouTube-first expansion.
- Open Issues before this audit: #1 Spotify policy/model-visibility Research.
- Concurrent Issue created during this audit: #2 Canonical Track Resolution Ledger + review-before-write.
- New Issues by this audit: #3, #4, #5.
- Closed Issues: none found.
- PRs: none open.
- Branches: main only.
- Actions/status: none for the audited head.
- Existing audits: no earlier quality-audit file found for this repository.

## Competitive Intelligence

Sources checked 2026-09-14:

- YouTube Music playlist creation/editing: https://support.google.com/youtubemusic/answer/7205933
- YouTube Music playlist transfer: https://support.google.com/youtubemusic/answer/14729358
- Soundiiz: https://soundiiz.com/
- TuneMyMusic transfer: https://www.tunemymusic.com/features/transfer
- YouTube playlists.insert: https://developers.google.com/youtube/v3/docs/playlists/insert
- YouTube playlistItems.insert: https://developers.google.com/youtube/v3/docs/playlistItems/insert
- Google OAuth best practices: https://developers.google.com/identity/protocols/oauth2/resources/best-practices
- GitHub Node CI: https://docs.github.com/en/actions/tutorials/build-and-test-code/nodejs

### Capability matrix

| Capability | This MCP | YouTube Music native | Soundiiz | TuneMyMusic | IFTTT-style automation | Manual/API script |
|---|---|---|---|---|---|---|
| Target user | MCP power user | Mainstream listener | Multi-service curator | Migrating listener | No-code automator | Developer |
| Value | Local intent → classified playlist write | Native listening/library | Transfer/sync across services | Guided transfer | Trigger/action recipes | Full control |
| Killer feature | Deterministic category + preview/apply | Native catalog/context | Broad service coverage | Simple guided migration | Event automation | Custom logic |
| Onboarding | Node + API/OAuth setup | Already signed in | Connect accounts | Connect accounts | Connect accounts | Code/credentials |
| Exact item review | Partial; exact ID good, free-text top-1 unsafe | User chooses visible item | Transfer review/match handling | Guided selection/matching | Recipe-dependent | Developer-defined |
| Write receipt | Basic added/skipped; partial ambiguity | Visible UI state | Success/partial/failed history | Progress/result UI | Run history | Custom |
| Automation/AI | MCP assistant + deterministic rules | Native recommendations | Transfer/sync | Matching/transfer | Rule automation | Optional |
| Integrations/API | YouTube + legacy Spotify | YouTube ecosystem | Many services | Many services | Many apps | Anything coded |
| Mobile | No | Strong | Web/mobile | Mobile web | Apps/web | Usually weak |
| Reliability | Tests exist; no CI/read-back | Provider-native | Hosted job/history | Hosted job/progress | Hosted run log | Varies |
| Security/privacy | Local, but plaintext token handoff | Provider-native | Hosted OAuth | Hosted OAuth | Hosted OAuth | Varies |
| Pricing | Open local code; no service price | Freemium subscription product | Free/paid | Free/paid | Free/paid | Time/API cost |
| Open/closed | Source visible, no LICENSE found | Closed | Closed | Closed | Closed | User-owned |
| Community/docs | Early README | Large help ecosystem | Mature help | Product docs | Template ecosystem | Self-supported |
| Distribution | GitHub/MCP config | Bundled app | Web/app | Web | Platform | Manual |
| Common strength | Focused local workflow | Lowest friction | Breadth | Simple transfer | Automation reach | Flexibility |
| Common weakness | Setup/trust gaps | Limited programmable classification | Account/data breadth | Transfer-centric | Opaque recipe failures | Maintenance burden |

### Competitive gaps

- MUST MATCH: secure OAuth credential lifecycle (#3); exact/reviewed identity (#2); truthful partial outcomes and safe retry (#4); commit-bound regression evidence (#5).
- SHOULD BE BETTER: local-first receipts, explicit provider/quota state, exact-video read-back, deterministic category rules.
- DIFFERENTIATOR: MCP-native single-track capture from link or intent into a predictable private category playlist without hosting the user’s library.
- DO NOT COPY: full catalog transfer, multi-account sync, social discovery, subscription billing, recommendation feeds, collaborative workspaces, or opaque match confidence.

## Virtual Executive Board

| Role | Question | Opportunity | Priority / cross-review |
|---|---|---|---|
| CEO | What must be true before users trust writes? | Own the local trustworthy effect-broker niche | #3, #2/#4, #5; do not expand providers |
| CPO | Is the job “transfer everything” or “save this exact item safely”? | Focus on single-item capture and transparent organization | Simplify scope; resolution and receipts first |
| CTO | Where are identity, authority, effect, and verification separated? | Typed credential, resolution, plan, and receipt contracts | #3, #2, #4 |
| Staff/Principal Engineer | Which state transitions are currently implicit? | Explicit save state machine and failure injection | #4 then #5 |
| UX Lead | Can a user understand preview, apply, partial, and retry? | Human-readable non-secret receipts | #2/#4 |
| UX Researcher | Which inputs are actually ambiguous for target users? | Runtime fixture set for live/remix/cover/clean variants | #2 Research; no invented accuracy |
| Growth Lead | What could create adoption without scope explosion? | Fast exact-link save for MCP users | Improve onboarding after #3; no social growth loop |
| CFO/Business Analyst | Where are quota and support costs hidden? | Count search/create/insert units per receipt | #4; avoid blind retries and paid canaries |
| Security/Privacy Lead | Where can bearer credentials persist? | Secure local credential provider, revoke/status | #3 P1 |
| QA Lead | Which core journeys lack deterministic regression? | Secret canary, stale resolution, partial write, MCP smoke | #5 |
| SRE Lead | Can “failed” mean a side effect occurred? | FAILED_NO_SIDE_EFFECT / PARTIAL / UNKNOWN_AFTER_WRITE | #4 |
| Accessibility Specialist | Are CLI/MCP states machine-readable and screen-reader understandable? | Stable typed states before UI claims | Runtime pending; no defect claim |
| Customer Support Lead | What evidence resolves “it failed but changed my playlist”? | Non-secret operation receipt and safe next step | #4 |

Cross-review consensus: secure and truthful boundaries are NOW. Minority opinion: early prototypes can tolerate manual env files and no CI. The board rejects that for a tool holding write-capable refresh tokens and making provider mutations. A second minority opinion favors automatic cleanup of empty playlists; Security/Support reject deletion without proof that the playlist was created by the same operation and remains empty.

## 50 Synthetic Personas

Coverage: 30 regression-baseline personas (B01–B30) and 20 rotating exploratory personas (R31–R50). Every row is a simulated journey, not a real participant result.

| ID | Background | Goal | Expectation | Task | Journey | Friction | Result | Comment | Sev | Suggestion |
|---|---|---|---|---|---|---|---|---|---|---|
| B01 | 22, student, medium skill, Android/5G, first use | Save study song | One safe step | Share exact YT link | link→preview→apply | OAuth copy setup | Success likely; runtime unknown | Exact link is clear | P2 | Secure auth |
| B02 | 34, backend dev, high skill, Linux/fiber | Auto-sort finds | Deterministic receipt | Text search then Chill | text→top1→preview | Identity not authoritative | Failure risk | “Show exact chosen ID” | P1 | #2 |
| B03 | 29, designer, medium, macOS/Wi-Fi | Save focus track | No terminal secrets | Authorize account | OAuth→callback | Tokens printed | Simulated failure | “I am screen sharing” | P1 | #3 |
| B04 | 41, SRE, high, Linux/VPN | Safe retry | Typed partial state | Create missing playlist | create→insert timeout | Generic error | Failure | “Can I retry?” | P1 | #4 |
| B05 | 19, student, low, iPhone/4G | Use without setup burden | App-like onboarding | Configure MCP | docs→OAuth→env | Node/API console | Abandon likely | Too technical | P2 | Keep niche, improve docs |
| B06 | 37, QA, high, Windows/fiber | Trust main | Green commit receipt | Inspect CI | repo→Actions | No runs/status | Failure | Tests are not receipts | P1 | #5 |
| B07 | 26, musician, medium, Mac/Wi-Fi | Save studio version | Correct recording | Search title | preview top result | Live/remix ambiguity | Failure risk | “Let me choose” | P1 | #2 |
| B08 | 52, collector, low, desktop/slow DSL | Avoid duplicates | Same song not repeated | Save exact URL twice | add→dedupe | Exact ID only | Success for same ID | Alternate uploads remain | P3 | Research semantic dedupe |
| B09 | 31, privacy engineer, high, Linux/offline-first | Local control | No hosted broker | Configure credentials | callback→store | Plaintext stdout/env | Failure | Local is good, lifecycle is not | P1 | #3 |
| B10 | 45, teacher, medium, Chromebook/Wi-Fi | Build lesson list | Private default | Save links | preview→apply | MCP unavailable on device | Failure | Needs desktop host | P3 | Document supported host |
| B11 | 28, power user, high, Linux/fiber | Rapid exact-link capture | No search quota | Send video ID | ID→get→preview→add | None static | Success likely | Strong core journey | P3 | Preserve |
| B12 | 63, retiree, low, Windows/DSL, first use | Organize favorites | Plain language | Search old song | text→five candidates | Top1 silently privileged | Failure risk | Wrong version costly | P1 | #2 |
| B13 | 24, developer, high, macOS/5G hotspot | Revoke access | Clear lifecycle | Stop using tool | find token→Google revoke | No auth status/revoke | Failure | Cleanup missing | P1 | #3 |
| B14 | 39, support agent, medium, Windows/VPN | Diagnose complaint | Operation receipt | “Failed but playlist appeared” | inspect MCP error | No partial steps | Failure | Cannot answer safely | P2 | #4 |
| B15 | 33, CI maintainer, high, Linux | Reproduce change | Locked deterministic install | npm ci→test | local only | No hosted receipt | Failure | Lockfile is underused | P1 | #5 |
| B16 | 20, accessibility user, screen reader, Windows | Know what changed | Stable concise states | Apply save | response JSON | Generic error lacks state | Failure risk | Typed states help | P2 | #4 |
| B17 | 30, multilingual user, medium, Taiwan 4G | Find C-pop track | Region-aware match | Chinese text search | region→top1 | Region defaults implicit | Ambiguous | “Show region/candidates” | P2 | #2 |
| B18 | 36, playlist curator, high, Mac/fiber | Keep private lists | Private by default | Auto-create category | preview→create private | Partial state not visible | Partial risk | Default privacy good | P2 | #4 |
| B19 | 27, security reviewer, high, Linux | Verify no secret logs | Sentinel test | Read auth/tests | source→tests | No redaction test | Failure | High-value regression | P1 | #3/#5 |
| B20 | 48, hobby DJ, medium, desktop/Wi-Fi | Save remix intentionally | Exact selected version | Paste exact URL | preview→apply | None static | Success likely | Exact identity wins | P3 | Preserve |
| B21 | 23, student, low, shared computer | Temporary setup | Leave no credentials | Authorize/use/revoke | token→env | Persistent copy | Failure | Shared machine unsafe | P1 | #3 |
| B22 | 38, DevOps, high, container/CI | Run MCP container | No stdout secrets | Bootstrap auth | callback→logs | Central log retention | Failure risk | Do not auth in CI | P1 | #3 |
| B23 | 44, researcher, medium, slow VPN | Save from text | Retry without duplicates | Apply during timeout | create→unknown insert | Generic error | Failure | Needs UNKNOWN state | P1 | #4 |
| B24 | 32, open-source user, high, Linux | Know reuse rights | Clear license | Evaluate install | repo→LICENSE | No LICENSE found | Blocked decision | Not code defect | P3 | Owner licensing decision |
| B25 | 18, new developer, medium, Windows | Contribute safely | PR feedback | Edit classifier | push→PR | No CI | Failure | Hard to know breakage | P2 | #5 |
| B26 | 55, music librarian, medium, Mac | Consistent categories | Explain rules | Save genre track | classify→preview | Keyword rules may miss nuance | Acceptable | Determinism preferred | P3 | Document UNKNOWN category |
| B27 | 35, quota-conscious dev, high, Linux | Minimize API use | Cost per action | Search+create+insert | inspect calls | No quota receipt | Failure | 100+ units can be hidden | P2 | #4 receipt |
| B28 | 40, compliance lead, high, managed Mac | Least privilege | Scoped access | Review consent | full youtube scope | Scope broad/opaque | Concern | Needs explanation | P2 | #3 scope status |
| B29 | 25, creator, medium, mobile hotspot | Save own upload | Exact success | Paste URL | preview→apply | Provider availability unknown | Runtime pending | Needs read-back | P2 | #4 |
| B30 | 50, maintainer, high, Windows | Upgrade dependencies | Matrix confidence | npm update | test locally | No Node/OS matrix | Failure | Main can drift | P1 | #5 |
| R31 | 16, minor, low skill, school Chromebook | Save study mix | Safe consent | Setup | Cloud console→OAuth | Complexity/consent | Abandon | Not target now | P3 | Do not build youth onboarding yet |
| R32 | 68, low vision, low skill, iPad | Organize classics | Native mobile UI | Use MCP | no MCP host | Failure | Native wins | Outside current channel | P3 | Do not build app now |
| R33 | 46, incident responder, high, Linux | Investigate token exposure | Rotation guide | Discover stdout token | revoke→reauth | No first-class revoke | Failure | Recovery matters | P1 | #3 |
| R34 | 21, K-pop fan, medium, Android/5G | Save official MV | Correct official upload | Search title | top1 candidates | Fan uploads/remixes | Failure risk | Review needed | P1 | #2 |
| R35 | 37, parent, low, family PC | Keep private list | No public accident | Auto-create | default private | Good default | Success likely | Preserve private | P3 | Keep default |
| R36 | 29, data saver, medium, metered | Avoid repeated searches | Reuse confirmed match | Same text twice | search each call | Quota/data repeat | Failure | Cache reviewed identity | P2 | #2 |
| R37 | 42, API developer, high, unstable network | Exactly-once effect | Operation key | Apply save | response lost | Unknown side effect | Failure | Reconcile first | P1 | #4 |
| R38 | 33, YouTube creator, high, Mac | Add to named playlist | Exact playlist identity | Same-name lists | name lookup→first exact | Ownership/identity weak | Ambiguous | Use playlist ID | P2 | Require ID on ambiguity |
| R39 | 58, classical listener, medium, desktop | Choose performance | See candidates | Search work title | top1 selected | Many valid recordings | Failure | Automatic exactness impossible | P1 | #2 |
| R40 | 26, gamer, high, Windows | Quick ambient save | Low latency | Exact link | preview→apply | Two calls | Acceptable | Safety worth it | P3 | Preserve preview |
| R41 | 36, product manager, medium, Mac | Understand promise | Honest docs | Read README | features→setup | No maturity/runtime limits | Concern | Label alpha | P3 | Document scope |
| R42 | 31, legal ops, high, Linux | Assess license | License boundary | Inspect repo | no LICENSE | Cannot reuse confidently | Failure | Needs owner decision | P3 | Research/license |
| R43 | 24, privacy user, high, Tails/slow | Ephemeral use | No disk/token trace | OAuth | refresh token copy | Persistent secret | Failure | Access-only mode? | P2 | #3 |
| R44 | 47, playlist maximalist, medium, fiber | Save to >500 lists | Find exact target | Name lookup | list capped 500 | Target may be missed | Runtime pending | Use ID for scale | P3 | Research pagination/name ambiguity |
| R45 | 28, localization tester, high, Taiwan | Stable case matching | Locale-consistent | Turkish/mixed-case name | localeLowerCase | Host locale nuances | Unknown | Needs fixture | P3 | Add deterministic normalization test |
| R46 | 39, security architect, high, Windows | Threat-model desktop OAuth | PKCE + secure store | Review flow | client secret+state only | No PKCE | Failure | Use supported library | P1 | #3 |
| R47 | 52, support lead, medium, remote desktop | Guide setup | Redacted diagnostics | User shares terminal | tokens visible | Unsafe support flow | Failure | Never print secret | P1 | #3 |
| R48 | 27, OSS contributor, high, Linux | Add failure tests | Easy injection | Import server handler | server auto-connects | Testability may be limited | Likely friction | Extract orchestration | P2 | #4/#5 implementation |
| R49 | 34, finance owner, high, desktop | Bound costs | Quota receipt | 50 saves | search/create/insert | Cost invisible | Failure | Count units | P2 | #4 |
| R50 | 43, red-team engineer, high, Linux | Prevent bloat | Small attack surface | Review roadmap | provider/UI ideas | Scope temptation | Pass if narrowed | Keep effect broker | STRATEGIC | DON'T list |

### Synthetic Preference Share

| Choice | Personas | Simulated share | Why |
|---|---:|---:|---|
| YouTube Music native | 16 | 32% | Lowest setup cost, mobile, direct visual selection |
| This MCP | 13 | 26% | Local automation, deterministic categories, exact-link workflow |
| Soundiiz | 8 | 16% | Multi-service transfer/sync and result history |
| TuneMyMusic | 6 | 12% | Guided migration and mobile web |
| IFTTT-style automation | 4 | 8% | Familiar no-code triggers |
| Manual playlist/API script | 3 | 6% | Maximum control or zero new trust |

The 26% is a scenario-model output, not market share or survey data. The MCP is strongest among technical exact-link users; native YouTube Music wins mainstream/mobile users. Fixing #2–#5 should improve trust, not be represented as a forecasted percentage lift.

## Red Team

- Persona bias: the sample overrepresents technical MCP users; mainstream users would likely choose native YouTube Music more often.
- Competitor bias: Soundiiz/TuneMyMusic are transfer products, not direct single-track MCP substitutes. They are used only for transferable identity, review, status, and OAuth signals.
- Confirmation bias: local-first architecture is not inherently secure; #3 proves local tools can mishandle secrets.
- Overengineering: a full distributed transaction engine, hosted ledger, embeddings matcher, or DPoP rollout may exceed the product. Start with typed states, exact IDs, provider read-back, and a local credential adapter.
- Feature bloat: do not add social, collaboration, recommendation, mobile, subscription, or dozens of providers.
- Copying competitors: multi-service breadth is not the moat. Trustworthy intent/effect separation is.
- Growth pressure: no public SaaS or account aggregation until provider terms, privacy, and operations justify it.
- Simplification option: Spotify tools may need to remain disabled or separated until #1 resolves policy/model visibility.
- Removal option: retire plaintext token printing; consider rejecting free-text apply entirely until #2 produces a reviewed resolution.
- Strongest counterargument: because users explicitly call apply, wrong identity and partial state are their responsibility. Rebuttal: approval is meaningful only when the identity/effect being approved is stable and the result is truthful.

## Findings and Priority

| ID | Type | Priority | Impact | Strategic | Gap | Risk reduction | Confidence | Effort | Root |
|---|---|---|---:|---:|---:|---:|---|---|---|
| F-01 | SECURITY | P1 | 9 | 9 | 9 | 10 | High | M | Plaintext OAuth token handoff |
| F-02 | RELIABILITY | P2 | 7 | 8 | 8 | 8 | High path / Medium frequency | M | Two-write save collapses partial state |
| F-03 | RELIABILITY, TECH_DEBT | P1 | 8 | 9 | 9 | 9 | High | S–M | Tests exist without default-branch receipt |

Priority ordering uses REMOVE > SIMPLIFY > FIX > IMPROVE > ADD:

1. REMOVE plaintext secret output.
2. SIMPLIFY credential and effect contracts.
3. FIX partial/unknown outcomes and regression gate.
4. IMPROVE identity review through #2.
5. ADD nothing broad until gates pass.

## GitHub Issue Mapping

| Finding | Fingerprint result | Action | GitHub object |
|---|---|---|---|
| F-01 | No open/closed same root | NEW | #3 — https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/3 |
| F-02 | No open/closed same root | NEW | #4 — https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/4 |
| F-03 | No open/closed same root | NEW | #5 — https://github.com/Reese-max/spotify-playlist-organizer-mcp/issues/5 |

Mapping: 3/3 PASS.

Duplicate/concurrent scope:

- #1 owns Spotify policy/model-visible content; not duplicated.
- #2 appeared during the audit and owns canonical YouTube identity resolution/review-before-write; treated as active concurrent work and not modified.
- Multiple persona symptoms were merged by root into #3, #4, or #5.

## Roadmap

### NOW

- #3 secure credential lifecycle.
- #5 default-branch deterministic gate.
- Keep free-text apply fail-closed or review-only pending #2.
- Define #4 typed partial/unknown receipt before expanding mutation paths.

### NEXT

- #2 runtime research and a narrow build/no-build decision.
- #4 failure injection, operation reconciliation, exact-video read-back, and quota receipts.
- Document supported Node/OS/MCP-host matrix and alpha maturity.
- Owner decision on LICENSE and reuse boundary.

### LATER

- Calibrated semantic duplicate research only after exact-ID/identity receipts work.
- Limited local import/export receipts if target users demonstrate need.
- Accessibility and slow-network runtime testing on supported clients.

### DON'T

- Hosted multi-account SaaS.
- Social/community playlists.
- AI recommendation/generation feed.
- Native mobile app.
- Marketplace/subscription.
- Bulk provider expansion.
- Automatic deletion of playlists after ambiguous failure.
- Opaque confidence scores.
- Real provider credentials or paid API canaries on every PR.
- Spotify workaround that bypasses #1.

## Change from Previous Round

No earlier product-board audit file was found for this repository. This is the baseline round.

Material changes before the baseline:

- Initial Spotify-first commit 87c42846.
- YouTube-first commit 28589712 added primary product surface.
- #1 opened for Spotify policy/model-visibility.
- #2 was created concurrently during this audit for canonical identity resolution.
- This audit created #3–#5.

## Regression

| Object | Status | Evidence |
|---|---|---|
| #1 Spotify policy boundary | CANNOT VERIFY / RESEARCH_REQUIRED | Open; no runtime/legal decision or fix receipt |
| #2 Track Resolution Ledger | CANNOT VERIFY / RESEARCH_RUNTIME_REQUIRED | Newly created concurrently; no implementation/PR |
| #3 OAuth token lifecycle | STILL REPRODUCIBLE statically / NEEDS_RUNTIME_VERIFICATION | Current auth script prints tokens |
| #4 Partial save state | STILL REPRODUCIBLE statically / NEEDS_RUNTIME_VERIFICATION | Current sequence has separate create/insert and generic error |
| #5 Default-branch CI | STILL REPRODUCIBLE | No workflow/run/status for audited head |

Verified Fixed: 0. No Issue was closed or reopened. No code change was treated as a fix merely because it exists.

## Runtime Pending

- Disposable-account OAuth with correct client type, PKCE, secure store, revoke, invalid_grant, and redaction.
- Real YouTube exact-link, free-text ambiguity, region, unavailable video, and review/apply behavior.
- playlists.insert → playlistItems.insert failures, lost responses, eventual visibility, retry, and read-back.
- Quota unit/request receipts.
- Actual npm test and MCP smoke on Node/OS matrix.
- GitHub runner assignment, steps, log redaction, and commit-bound green receipt.
- Screen reader/keyboard, slow network, mobile companion limitations.
- >500 playlists/name ambiguity and locale normalization.
- LICENSE/owner decision.

## Decision Memo

- What this product should become: a local, YouTube-first MCP effect broker that turns reviewed intent into safe private playlist mutations with exact receipts.
- Who it should serve: technical YouTube/YouTube Music users already using MCP clients, especially exact-link and deterministic-organization workflows.
- Why users would choose it: local control, one-step link capture, deterministic categories, preview/apply separation, and auditable writes.
- Why users choose competitors: native mobile UX, no setup, multi-service breadth, transfer history, guided review, and established support.
- Biggest competitive gaps: credential safety, canonical identity, partial/unknown mutation truthfulness, read-back, and CI.
- Potential moat: reusable separation of User Intent → Provider Identity → Approval → Effect → Verified Receipt, implemented locally and transparently.
- Top strategic/engineering/UX priorities: #3; #2/#4; #5.
- What NOT to build: hosted SaaS, social playlists, recommendations, native app, marketplace, broad providers.
- Features worth removing: plaintext token printing; unreviewed free-text apply until #2.
- Biggest risks: bearer-token exposure, wrong recording saved, ambiguous provider side effects, quota waste, Spotify policy conflict, early scope sprawl.
- Next experiments: disposable-account auth redaction spike; wrong-version fixture study; create-success/insert-failure state machine; actual CI receipt.
- Decision: INVEST / SIMPLIFY.
- Reason: the focused job is useful and differentiated for MCP power users, but trust infrastructure must catch up before product breadth.

## Portfolio CEO Review

Baseline portfolio ranking remains:

1. academic-mcp — strongest differentiated research infrastructure; reliability/recovery gates remain critical.
2. autodev-ng — strategic automation control plane; contract/repair reliability first.
3. police-exam-archive — clearest end-user education product.
4. ai-flight-radar — focused opportunity; live quote fidelity gate first.
5. lobsterpulse — useful observability niche; security and metric-contract work first.
6. spotify-playlist-organizer-mcp — promising new local effect broker, currently constrained by #1–#5 trust boundaries.

Portfolio consolidation:

- Reuse a shared CredentialProvider/redaction contract across MCP/provider repositories.
- Reuse a shared Plan/Approval/Apply/Read-back Receipt schema across academic-mcp, autodev-ng, ppt-studio, ai-flight-radar, and this repo.
- Reuse default-branch deterministic CI templates and secret-sentinel tests.
- Do not create another AI gateway, agent framework, auth service, design system, or hosted data layer solely for this repository.
- Keep Spotify policy classification from #1 reusable as a provider-data policy manifest pattern.

Other repositories retain the previous portfolio baseline; this round does not claim a fresh deep audit or Runtime verification for them.

## Mandatory Validation

- Total Findings: 3.
- New Issues Created: 3 — #3, #4, #5.
- Updated Existing Issues: 0.
- Reopened Issues: 0.
- Research Issues: 0 new by this audit; concurrent existing #2 remains Research.
- Duplicate Avoided: 18 symptom/opportunity groups, including #1 policy scope, #2 identity-resolution scope, semantic duplicate research, license decision, >500-playlist pagination, locale normalization, and persona symptoms merged to three roots.
- Issue Write Blocked: 0.
- Concurrent/locked scope avoided: #2 appeared during duplicate re-check and was treated as active parallel work; no comment, branch, or body update was made by this audit.
- Rejected Findings: 14:
  1. Real token compromise — no Runtime evidence.
  2. Real wrong-track incident — no Runtime evidence and #2 owns research.
  3. Production duplicate-empty-playlist incident — no Runtime evidence.
  4. P0 YouTube outage/quota incident — no evidence.
  5. Full multi-service transfer SaaS — scope bloat.
  6. Native mobile app — wrong stage/channel.
  7. Social/collaboration layer — no target evidence.
  8. AI recommendation feed — different job and privacy cost.
  9. More providers — #1 unresolved and breadth before trust.
  10. Automatic playlist deletion on error — unsafe without ownership/state proof.
  11. Semantic dedupe by title/channel — false-positive risk; Research later.
  12. Hosted credential broker — unnecessary infrastructure/privacy expansion.
  13. Real provider canary on every PR — credential/quota risk; bounded manual canary instead.
  14. Accessibility/performance defect claims — no runtime or human evidence.
- Verified Fixed: 0.
- Priority distribution: P0 0 / P1 2 / P2 1 / P3 0 / STRATEGIC 0.
- Highest Priority: #3 and #5; #2 remains a critical Research dependency.
- Finding mapping: 3/3 PASS.
- Report commit validation: Actions/status must be checked after this write; absence will not be called success or failure.

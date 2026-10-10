# Selected-video binding research: NARROW

The original #2 asks whether exact-ID apply or a minimal selection parameter is sufficient before adding a persistent resolution ledger. The current main `47eed58f219ffba0beb11bf4844c7711e663e38d` already supports `videoId`, rejects unbound free-text apply before playlist lookup, and retains exact ID/URL fast paths. The canonical PR's three cases were normally reconciled with current main: all current cancellation, quota, partial-write, read-back and deduplication cases remain, and runtime source is unchanged.

**Decision: NARROW.** Use the existing exact identity path and existing `videoId` parameter, with formal handler evidence and the existing README guidance. A client must forward the ID of the candidate the user selected, rather than resubmit search text as if it carried that choice. No new ledger, parameter, provider behavior or persistence mechanism is needed to meet this bounded contract.

## Actual handler experiment

[Receipt](selected-video-binding-receipt.json) records all five original acceptance mappings, source hashes, environment, command, expected outcomes and the exact observed values enforced by assertions. [Focused output](selected-video-binding-focused.txt) preserves the three executed test outcomes. Run the saved command from the exact candidate checkout after `npm ci`; run `npm test`, `npm run lint` and `npm run test:coverage` for the full source gates.

The experiment invokes the actual registered stdio MCP handler and production `YouTubeClient`, with the API base pinned to a loopback HTTP fixture and each library/credential path confined to a temporary directory. It does not invoke a real provider or account.

| Case | Expected and verified actual result |
| --- | --- |
| Text preview; user selects candidate #2; next search reorders and omits that selected row | Preview writes nothing. Unbound apply returns `selection_required` without playlist lookup. Supplying selected `BBBBBBBBBBB` applies exactly that ID, does not search, and makes one exact video lookup. |
| Selected video becomes unavailable | Exact lookup errors; no fallback search, playlist lookup, playlist creation or insertion occurs. |
| Exact URL directly applied | `AAAAAAAAAAA` is added with no search and no mandatory extra preview round trip. |

All three cases check receipts, stdout and stderr for fixture-secret disclosure. The full 280-test suite also retains existing exact-ID duplicate, preview-zero-write, read-back, cancellation and partial-write contracts. Full lint passes; coverage passes at 94.83% lines, 84.86% branches and 93.51% functions. These local assertions are not real matching-accuracy measurements.

## Three candidate comparison and remaining boundaries

| Candidate | Same selected-identity success condition | Decision |
| --- | --- | --- |
| Existing exact-ID capability plus client guidance | The chosen ID is carried explicitly; refreshed search rank is irrelevant. | Sufficient; keep existing capability and guidance. |
| Documentation alone while repeating unbound search text | Search text does not encode the prior selected row. Current handler safely requests selection instead of silently writing a new first result. | Insufficient as a selected-identity representation; client must send exact ID. |
| A local selected-video parameter | Current `videoId` already provides this binding, with direct lookup and fail-closed unavailability. | Sufficient; no additional parameter required. |

Additional persistence is considered only if a concrete, reachable failure remains after explicit identity binding. This experiment establishes none on current source. It does not establish a historical incident or a P0-P3 severity from heuristic scores. Client failure to retain/send the chosen ID, actual human choice quality, real provider availability/account writes and equivalence of different uploads remain outside the bounded research.

The original research explicitly starts with zero-provider isolated fixtures and states that research completion is neither implementation approval nor a provider runtime pass. These future human/live-provider checks are not extra conditions for closing this original research. The PR continues to target `feat/issue-9-library`, the integration source of truth specified by AGENTS.md; root controls integration and any current-main closure readback.

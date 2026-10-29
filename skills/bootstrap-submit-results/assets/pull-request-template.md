## Summary
Results for experiment `<experiment-id>`: <one sentence on the question and the outcome, without claiming more than the evidence supports>.

- **Hardware and target model:** <platform, memory; model repository, revision, weights>
- **Builder and harness:** <builder model; development harness and version>
- **Evaluation:** <evaluation id> at revision `<full commit>` (definition sha256 `<hash>`)
- **Comparison track:** <matched-configuration / best-permitted-configuration>
- **Acceptance:** <unverified / passed / failed>, with the gap to each frozen target
- **Claims made:** <none, or each claim type with its bounds>

## Included
- `experiments/<experiment-id>/contract.json`: the frozen contract (revision `<commit>` in the project repository, frozen <timestamp>)
- `experiments/<experiment-id>/report.md`, including the feedback section
- `experiments/<experiment-id>/runs/<run-id>/`: <n> runs (<completed / interrupted / failed counts>), each with its run record and result documents
- Skills revision: `<full commit>`

## Evidence access
<Public evidence links. For local-only evidence: what it is, its sha256, and who can obtain it. No raw evidence is committed.>

## Implementation
<Link to the engine repository, commit, or pull request. It is separate from this results change; this pull request does not adopt it.>

## Not verified
<Single-cohort or preliminary results, unmatched comparison conditions, missing metrics, unreconciled requests, anything not independently checked.>

## Validation
- `npm ci && npm test`: <result>
- `node tools/leaderboard/build-index.mjs . --out <file> --require-validation`: <entries written, quality-gate states>
- Evaluation pin: `<revision>` is in the history of `main`; the definition hash matches
- Private-material scan: <what was searched and what was found>

No merge is authorized by this description.

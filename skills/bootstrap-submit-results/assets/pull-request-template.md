## Summary
Results for experiment `<experiment-id>`: <one sentence on the question and the outcome, without claiming more than the evidence supports>.

- **Hardware and target model:** <platform, memory; model repository, revision, weights>
- **Evaluation:** <evaluation id> at revision `<full commit>` (definition sha256 `<hash>`)
- **Comparison track:** <matched-configuration / best-permitted-configuration>
- **Goals:** each threshold in `goal_thresholds` marked met, missed, or open, with the gap to each
- **Claims made:** <none, or each claim type with its bounds, the comparison engines, the date, and the uncertainty>

## Included
- `experiments/<experiment-id>/experiment.json`: the frozen experiment (revision `<commit>` in the project repository, frozen <timestamp>)
- `experiments/<experiment-id>/evaluation/`: <n> evaluation reports (<complete, failed, and interrupted counts>), each named after its UTC start time
- Endpoint: <how the engine, at the commit the experiment records, was started (command, runtime and artifact hashes), on which hardware, and any deviation from the experiment; the reports record neither>
- Conditions: <operating system and toolchain, power mode, memory limit, KV and state precision, memory and swap observed, and any deviation from matched conditions>

## Interpretation
<Comparable conditions, differences, and limits of attribution. Variability and unresolved correctness or resource concerns. Regressions and failed checks, with their causes. Failures, amendments, and next steps.>

## Evidence access
<Public evidence links. For local-only evidence: what it is, its sha256, and who can obtain it. No raw evidence is committed.>

## Implementation
<Link to the engine repository, commit, or pull request. It is separate from this results change; this pull request does not adopt it.>

## Feedback for future experiments
Reviewed text only. Refer to private artifacts by hash and access limitation; do not paste transcripts, weights, credentials, or private prompts. A suggestion here becomes a change only through a separate pull request.

- Failures, interruptions, and their causes:
- Preflight checks that would have caught them earlier:
- Suggested changes to skills or evaluations (cite the evaluation report and evidence hash):
- Calibration notes for goal thresholds (priors only; each experiment fixes its own before the first evaluation):
- Limits on generalizing: preliminary cohorts, unmatched comparisons, hardware-specific effects:

## Not verified
<Single-cohort or preliminary results, unmatched comparison conditions, missing metrics, incomplete tests, reports of the quick profile, an assumed context window, anything not independently checked.>

## Validation
- `npm ci && npm test`: <result>
- `node tools/leaderboard/build-index.mjs . --out <file> --require-validation`: <entries written, quality-gate states>
- Evaluation pin: `<revision>` is in the history of `main`; the definition hash matches
- Private-material scan: <what was searched and what was found>

No merge is authorized by this description.

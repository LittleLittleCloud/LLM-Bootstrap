# Experiment: <ID>

Status: Draft / Running / Completed / Interrupted. Acceptance: Unverified / Passed / Failed.

## Question and frozen contract

- Hypothesis and platform-specific goal:
- Contract file, revision, and freeze timestamp:
- Skill repository full SHA and instruction hashes:
- Starting engine/scaffold SHA and permitted reuse/dependencies:
- Hardware, OS, driver, compiler, power and memory limits:
- Target model/revision; weight/tokenizer hashes; all precisions:
- Builder model/provider/identifier, initial inference location, and tool access:
- Development harness version/hash:
- Evaluation reference (id, repository revision, definition hash), warm-up, and formal repetitions:
- Numerical oracle/tolerances:
- Baseline engines/revisions, selection date/method, and comparison tracks:
- Primary metric, numerical targets, quality/resource gates:
- Budget and stopping rule:
- Scope authorization and unresolved fields:

## Execution and evidence

- Run IDs and timestamps/timezone:
- Actual runtime SHA and executable/kernel hashes, separate from checkout:
- Reproduction commands and configuration hashes:
- Warm-up, repetitions, resource sampling, and contention checks:
- Public raw evidence links or local-only locations with hashes:
- Human interventions and agent trajectory access/hash:
- Builder token/cost, hardware hours, elapsed time, and attempts:

## Results

Use “Not obtained” for unavailable values. Preserve all formal repetitions and failures.

| Metric / gate | Baseline | Candidate | Definition, coverage, and conditions |
| --- | --- | --- | --- |
| Numerical/state correctness | | | |
| Official assertions / fixed task count | | | |
| Prefill tokens / seconds / tok/s | | | |
| Decode intervals / seconds / tok/s | | | N−1; native command metrics separate |
| Client TTFT median / variability | | | |
| Application duration and request/token totals | | | |
| Memory, pressure, swap-out and resource gates | | | |
| Errors / timeouts / incomplete tasks | | | |

## Interpretation and disposition

- Comparable conditions, differences, and limits of attribution:
- Variability/repetitions and unresolved correctness/resource concerns:
- Gap to each frozen target; bounded baseline/SOTA conclusion:
- Self-hosting transition and subsequent development evidence, or not demonstrated:
- Failures, amendments, recovery, and next steps:
- Implementation PR, independent results PR, and adoption decision:

## Feedback for future experiments

Reviewed text only. Refer to private artifacts by hash and access limitation; do not paste transcripts, weights, credentials, or private prompts. A suggestion here becomes a change only through a separate pull request.

- Failures, interruptions, and their causes:
- Preflight checks that would have caught them earlier:
- Recurring human interventions and what would have avoided them:
- Suggested changes to skills or evaluations (cite the run and evidence hash):
- Calibration notes for baselines, budgets, thresholds, and tolerances (priors only; each contract fixes its own before tuning):
- Limits on generalizing: preliminary cohorts, unmatched comparisons, hardware-specific effects:

# Evaluation protocol

This protocol defines how engines are evaluated. It is separate from the [experiment protocol](experiment-protocol.md), which defines what an experiment fixes and claims. Its structure is formalized in the [evaluation schema](../schema/evaluation-protocol.openapi.json), which checks shape only. This prose and the skills remain authoritative.

## Repository-owned evaluation

Evaluations are defined by this repository, not by individual experiments. An evaluation's definition, its driver and assertion-evaluator scripts, and its numerical-check code live under `evaluations/<evaluation-id>/` and change only through reviewed pull requests to this repository. An experiment selects an evaluation by id, repository revision, and definition hash. It does not carry, replace, or patch evaluation code.

The builder LLM does not write or edit evaluation definitions, scripts, dataset pins, or scoring during an experiment, so it cannot shape how its own engine is judged. A needed change is made in this repository outside any experiment and produces a new revision, which is a different evaluation. Earlier results stay tied to the revision they used.

Run an evaluation from the pinned repository revision. Check every script against its recorded hash before use, and never run from a modified checkout. The pinned scripts emit the result documents (see Results below); do not edit them by hand.

## Evaluation definition

Each evaluation has a definition file, `evaluations/<evaluation-id>/evaluation.json`, that fixes:

- The agent harness name and version that drives the endpoint under test.
- The dataset repository, revision, file, and hash, the exact task IDs, and the seed.
- Input/output limits, per-task timeout, request concurrency, cache policy, and sampling settings for the target model.
- The scripts that carry out the evaluation, each with a role (driver, assertion evaluator, or numerical check), a path inside the evaluation directory, and a content hash.

A definition is a `draft` or `released`. A released definition has every field resolved, and every script exists in the repository and matches its hash. A draft has unresolved fields and cannot be used for formal runs.

The experiment contract keeps only what depends on the experiment: the evaluation reference, the warm-up plan, formal repetitions, and the numerical oracle and tolerances. Tolerances depend on the target model and declared precision, so they are chosen before candidate results are inspected. The code that applies them is still repository-owned.

No evaluation has been released yet. The driver behind the prior Infer.NET measurements is external to this repository. It measures Pi coding-agent wall time and records `correctness_evaluated: false`, so it does not satisfy this protocol. Those measurements are prior evidence only.

## Correctness before performance claims

Validate tensor shapes/layouts, tokenizer and chat formatting, model operators, state/KV continuity, reset behavior, and representative short/long inputs against an independent reference. Choose tolerances appropriate to declared precision before inspecting candidate results. Localize the first differing logits/state when practical; plausible text alone is insufficient.

Retain application-level task checks as a separate quality gate. A coding agent can call the model repeatedly and repair solutions; a 20-task assertion pass is not model pass@1 or evidence of numerical equivalence. Run generated programs in a restricted evaluation environment with no credentials or network and bounded resources. Preserve timeouts/errors in the denominator and verify the assertion evaluator with a negative control.

## Measurement

Run baselines and candidates serially on the same device under documented conditions. Separate cold load/compilation, warm-up, and steady state. Preserve every formal repetition and failure; report variability across repetitions. A single cohort is preliminary evidence, not a stability study.

Collect per-request native timings, client observations, input/output token counts, cache hits, request IDs, actual runtime builds/artifact hashes, and sampling coverage. A checkout commit does not prove the deployed executable's identity. Reconcile request counts and token totals with the harness before reporting complete metrics.

- Prefill throughput: sum of processed input tokens divided by sum of measured prefill seconds; define whether queueing, transfer, and state import are included. Cached tokens are identified separately.
- Decode throughput: sum of N−1 generation intervals divided by sum of first-to-last token durations. Requests with fewer than two tokens have no such throughput. Engines reporting command-level tokens/time or speculative multi-token emissions require their native definition to be reported separately; do not relabel it N−1.
- Client TTFT: monotonic time from request dispatch to first valid text/tool output. Ignore role-only, heartbeat, and usage events. Disclose proxy boundaries and observation overhead.
- Application duration: full task/cohort time, separate from GPU work. For interactive workloads, generated requests may diverge between engines; retain trajectories and token totals. Use a separate fixed-request workload for controlled kernel/engine comparisons when needed.
- Resources: sampled memory allocation/footprint with definition and interval, memory pressure, whole-machine swap-out delta over bracketed boundaries, power/thermal conditions, and failures. Do not attribute whole-machine paging to a process without evidence.

Aggregate throughput as ratios of sums, not an arithmetic mean of request speeds. Do not derive prefill/decode from application wall time. Missing metrics are “Not obtained”, not zero. Use monotonic clocks on a common observer for end-to-end intervals; do not subtract uncalibrated cross-host timestamps.

## Results

Each engine measurement is one `EvaluationResult` document. It pins the evaluation reference it ran, records the observed environment (which may differ from the contract, so deviations are written down), identifies the deployed runtime by artifact hashes, and holds the settings used, every repetition including failures, run-level metrics, resources, and quality gates. Per-request records stay in a hashed evidence file it references.

An experiment's run record lists result documents by path and hash and must cite the same evaluation reference as its contract. Comparison, SOTA, and autonomy claims belong to the experiment protocol.

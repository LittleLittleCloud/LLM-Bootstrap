# Experiment protocol

## Research unit

An experiment fixes hardware, target model, builder LLM, agent harness, workload, resource budget, allowed dependencies, and acceptance criteria. An engine may specialize to that configuration. Record the skill repository commit and hashes of the exact instructions provided to the builder; a later skill revision defines a new treatment.

The builder LLM writes the engine. The target model runs inside it. Their identities may differ, but self-hosting requires the builder's inference to actually move onto the generated engine. Record where initial builder inference runs and who controls routing. Improving an engine while continuing to use an unrelated hosted builder is engine construction, not demonstrated self-hosting.

The example JSON is a planning aid. Its structure, and that of run records, is formalized in the [OpenAPI schema](../schema/experiment-protocol.openapi.json), which checks shape and required declarations only. It models just the core fields; per-request records and other raw detail stay in hashed evidence files. This prose protocol and the skills remain authoritative, and passing schema validation does not show correct measurements, followed procedure, or an experimental result. Every unresolved experimental field must be resolved or explicitly declared inapplicable before execution; a frozen contract forbids unresolved (null) fields. Keep separate identities for the development harness and evaluation driver.

## Freeze before tuning

Record:

- Experiment ID, goal, scope, baseline engine revisions, starting engine/scaffold revision, code reuse, and allowed implementation dependencies. State whether baseline source inspection is allowed. Wrapping a baseline engine does not demonstrate building an inference backend.
- Hardware model, GPU/core configuration, physical memory/VRAM, OS, drivers, compiler/runtime, power mode, thermal observations, and relevant memory limits. Record exclusive GPU use and any CPU fallback, offloading, SSD streaming, or multi-host participation.
- Target repository/revision, weight and tokenizer hashes, chat template, quantization method/group size, weight/activation/KV/recurrent-state precision, context limit, sampling settings, and speculative draft identities/settings.
- Builder model/provider/revision or provider-exposed identifier, inference location, decoding settings, tools, network/source access, harness version/revision, and starting context. Mark provider details that are unavailable; do not fabricate immutable IDs.
- Evaluation driver revision/hash, dataset revision/hash, exact task IDs and seed, request sequencing, input/output limits, timeout, cache policy, warm-up, formal repetitions, and correctness oracle/tolerances.
- Primary performance metric and numerical acceptance thresholds, permitted quality loss, memory/swap constraints, allowed optimizations, total wall-clock/token/compute budgets, and stopping rules. Explicitly state which operating-system changes are in scope; no silent precision or resource-limit relaxation.

Freeze the contract in version control before implementation. Amendments receive a new revision and a reason; they do not retroactively redefine a successful run. Existing user authorization governs execution. Missing essential configuration is resolved before dependent work, while independent preparation may continue.

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

## Baselines and SOTA

Select strong available engines using dated primary sources and measured support for the target hardware/model. Record how the candidate set was chosen and which plausible alternatives could not be evaluated. Historical repository results are evidence pointers, not an up-to-date SOTA survey.

Use matched precision, workload, caching, speculation, and resource settings for attribution. An additional best-permitted-configuration track may compare complete systems with different optimizations, provided the quality/resource envelope is fixed and every difference is disclosed. Keep these tracks separate. Never present the ratio of incompatible native timing metrics as a controlled engine speedup.

A bounded SOTA claim names the device, model, workload, metric, quality/resource envelope, comparison engines, date, and uncertainty. Without sufficient baseline coverage, say “best among tested configurations” or “competitive with [named baseline]”. Retest adoption against a changed baseline when relevant.

## Autonomy and self-hosting

Record all human interventions with timestamps and purpose: task setup, implementation hints, debugging, code edits, environment repair, and approval. Retain builder/tool traces privately as needed, publishing redacted evidence and hashes. Track builder tokens, API cost when available, elapsed time, experiments attempted, and hardware hours. Unavailable historical autonomy data remains unknown.

For self-hosting, record the exact transition point, builder/target identity match, generated engine runtime/artifact identity, actual harness endpoint routing, and subsequent development steps executed through that engine. Distinguish an external recovery path from uninterrupted self-hosting. A claim of recursive improvement also requires a measured subsequent engine revision, with correctness retained.

## Results and adoption

Keep implementation and results reviewable independently. Record failed, interrupted, neutral, and successful attempts; preserve original observations when appending corrections. Each run identifies the contract revision, skills revision, implementation/runtime SHA and artifact hashes, configuration, commands, raw evidence hashes/access, quality results, resource gates, metric coverage, and interpretation.

Submit project changes through feature branches and PRs. Results publication and code adoption are separate decisions; neither implies experimental success. Merge requires explicit authorization. Do not publish private machine addresses, credentials, proprietary prompts, or model weights. Local-only evidence is explicitly marked, never disguised as a public download.

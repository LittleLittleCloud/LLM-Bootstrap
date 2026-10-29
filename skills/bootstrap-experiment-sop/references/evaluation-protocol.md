# Evaluation protocol

This protocol defines how engines are evaluated. It is separate from the [experiment protocol](experiment-protocol.md), which defines what an experiment fixes and claims. Its structure is formalized in the [evaluation schema](../assets/schema/evaluation-protocol.openapi.json), which checks shape only. This prose and the skills remain authoritative.

## Repository-owned evaluation

Evaluations are defined by the LLM Bootstrap repository (`https://github.com/LittleLittleCloud/LLM-Bootstrap`), not by individual experiments. An evaluation's definition, its driver and assertion-evaluator scripts live under `evaluations/<evaluation-id>/` in that repository and change only through reviewed pull requests to it. An experiment selects an evaluation by id, repository revision, and definition hash. It does not carry, replace, or patch evaluation code.

The builder LLM does not write or edit evaluation definitions, scripts, dataset pins, or scoring during an experiment, so it cannot shape how its own engine is judged. A needed change is made in this repository outside any experiment and produces a new revision, which is a different evaluation. Earlier results stay tied to the revision they used.

## Obtaining an evaluation

Evaluations are not bundled with the skill; the repository above is the only source. Take them from the latest commit of its `main` branch:

1. When planning, resolve that commit: `git ls-remote https://github.com/LittleLittleCloud/LLM-Bootstrap.git refs/heads/main`.
2. Read the definitions and scripts at exactly that commit, for example in a scratch clone checked out at it, outside the project workspace and outside any installed plugin. Choose a `released` definition.
3. Record the full commit as the contract's evaluation `revision` and the definition file's sha256. Later stages use the recorded revision, never a newer `main`.

Do not use an evaluation copy that shipped with an installed plugin, was cached earlier, or has local changes.

Run an evaluation from the pinned repository revision. Check every script against its recorded hash before use, and never run from a modified checkout. The pinned scripts emit the result documents (see Results below); do not edit them by hand.

## Evaluation definition

Each evaluation has a definition file, `evaluations/<evaluation-id>/evaluation.json`, that fixes:

- The agent harness name and version that drives the endpoint under test.
- The dataset repository, revision, file, and hash, the exact task IDs, and the seed.
- Input/output limits, per-task timeout, request concurrency, cache policy, and sampling settings for the target model.
- The scripts that carry out the evaluation, each with a role (driver or assertion evaluator), a path inside the evaluation directory, and a content hash.

A definition is a `draft` or `released`. A released definition has every field resolved, and every script exists in the repository and matches its hash. A draft has unresolved fields and cannot be used for formal runs.

The experiment contract keeps only what depends on the experiment: the evaluation reference, the warm-up plan, and formal repetitions.

Evaluations in the repository at the time of writing (the commit you resolved is authoritative):

| Evaluation | Status | Result document | Purpose |
| --- | --- | --- | --- |
| `engine-api-conformance` | released | `ConformanceResult` | Cheap structural checks of an endpoint's OpenAI chat, OpenAI Responses, and Anthropic Messages behavior. |
| `humaneval-20-pi` | draft, no scripts | `EvaluationResult` | Planned 20-task coding workload from the prior Infer.NET measurements. |

The driver behind the prior Infer.NET measurements is external to this repository. It measures Pi coding-agent wall time and records `correctness_evaluated: false`, so it does not satisfy this protocol. Those measurements are prior evidence only.

When a script changes (a maintainer task in the repository), update its hash in the definition (for example with `shasum -a 256`). The repository tests fail until the hashes match.

## Endpoint conformance

`engine-api-conformance` is a correctness gate that runs before any performance measurement. Each check sends a few tiny requests (temperature 0, at most 64 output tokens) and validates response structure and protocol invariants. It does not judge model quality. Run reasoning models with thinking disabled so the small token budget is enough.

- **OpenAI chat completions:** the model list; non-streaming schema, `max_tokens`, stop strings, roles, and JSON mode; streaming framing, chunk shape, final usage chunk, and finish reason; tool calling with forced, selected, disabled, and automatic choice, tool-result round trips, and streamed tool-call fragments; and the error format.
- **OpenAI Responses:** the response object, `max_output_tokens`, input items, the named stream events in order with deltas that add up, function calling in both modes, and the error format.
- **Anthropic Messages:** the message object, `max_tokens`, stop sequences, system prompt and multi-turn input, the stream events in order, `tool_use` blocks and `tool_result` round trips, and the error format.
- **Text integrity and robustness (all three APIs):** non-ASCII text that survives streaming without split multi-byte characters, reasoning kept out of the answer text (`<think>` tags, reasoning fields, thinking blocks, reasoning items), malformed JSON bodies, empty `messages`, an unknown role, `max_tokens` of 1, and control-token strings in user text that must stay plain text.
- **Engine behavior (chat):** four simultaneous requests and streams that must not mix their answers, clients that disconnect in the middle of streams, output that must not change after requests that share the prompt prefix, and a prompt about twice the context window that must be rejected with a 4xx error and must not break the next request. The overflow checks need `--context-window` and are skipped without it.

Each check is `required` or `advisory`. Only required checks decide conformance. Advisory checks record common behavior the APIs do not mandate, such as identical output for repeated temperature 0 requests. An unsupported optional feature is a `skip`, not a pass. Checks share responses where they can, so a run takes about 70 small requests.

The driver checks every script against its hash before importing any of them, then repeats its negative control: a reference engine that must pass every check, and each of a set of injected faults, which must each be caught. An endpoint is reported conformant only for a complete run with a verified negative control. Run the driver from a checkout of the repository at the recorded revision.

```sh
python3 evaluations/engine-api-conformance/scripts/conformance.py \
  --endpoint http://127.0.0.1:8080 --model MODEL --engine-name NAME --context-window 4096 \
  --evaluation-revision FULL_COMMIT_SHA --output experiments/EXPERIMENT_ID/runs/RUN_ID/conformance.json
```

It needs Python 3.9 or newer and no packages. The endpoint must be a credential-free origin, and plain http is allowed only on loopback. Pass a key with `--api-key-file`; it is never logged or stored. The result records only whether the host is loopback, never an address. Failing checks write their requests and responses to a local-only evidence file next to the result.

## Correctness gates

Numerical equivalence with a reference implementation is not required. The correctness gates are the endpoint conformance evaluation and the application-level task checks, and neither is evidence of numerical equivalence.

Retain application-level task checks as a separate quality gate. A coding agent can call the model repeatedly and repair solutions; a 20-task assertion pass is not model pass@1. Run generated programs in a restricted evaluation environment with no credentials or network and bounded resources. Preserve timeouts/errors in the denominator and verify the assertion evaluator with a negative control.

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

Each engine measurement is one result document, of the kind the definition names in `result_schema`. A performance evaluation emits an `EvaluationResult`. It pins the evaluation reference it ran, records the observed environment (which may differ from the contract, so deviations are written down), identifies the deployed runtime by artifact hashes, and holds the settings used, every repetition including failures, run-level metrics, resources, and quality gates. Per-request records stay in a hashed evidence file it references. A conformance evaluation emits a `ConformanceResult` with one outcome per check, a summary, its cost, and the negative-control verdict.

An experiment's run record lists result documents by path and hash and must cite the same evaluation reference as its contract. Comparison, SOTA, and autonomy claims belong to the experiment protocol.

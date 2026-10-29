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
| `engine-throughput` | released | `EvaluationResult` | Fixed-shape throughput of a streaming chat endpoint: prefill by prompt length up to 216k, decode by context depth, an agent session with prefix-cache hits, and closed-loop concurrency, with client timing. |
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

## Fixed-shape throughput

`engine-throughput` measures the throughput of an OpenAI-compatible streaming chat endpoint with fixed request shapes. It is a performance measurement: it does not check output quality or API behavior, so run `engine-api-conformance` first. Here k means 1024 tokens.

| Workloads | Shape | Measures |
| --- | --- | --- |
| `prefill.in2k.out1`, `in4k`, `in8k`, `in216k` | 2k, 4k, 8k, or 216k prompt tokens, one output token | Prefill speed by prompt length |
| `decode.in128.out256`, `in8k`, `in32k` | 128, 8k, or 32k tokens of context, 256 output tokens | Decode speed by context depth |
| `agent.p32k.s256.t5`, `p128k` | One session of 5 turns that share a 32k or 128k prefix and append about 256 tokens each, one output token per turn | Large-window input with prefix-cache hits, as in an agent loop |
| `batch.c1`, `c2`, `c4`, `c8` `.in512.out64` | 1, 2, 4, or 8 closed-loop workers, each sending 4 requests of about 512 input and 64 output tokens | Aggregate throughput and per-request speed under concurrency |

The run-level `prefill`, `decode`, and `client_ttft_median_seconds` metrics are the single-stream headline workloads `prefill.in2k.out1` and `decode.in128.out256`. Every other workload is reported in the result's `workloads` list. A run may select a subset with `--workloads`, which is recorded in the settings. The 216k and 128k workloads are slow on a slow engine: a cold 216k prefill at 500 tok/s takes about seven minutes per pass.

- **Input length.** The engine's own `usage.prompt_tokens` (which includes the chat template) is the length. Up to 8k, the driver sizes each prompt with probe requests until the reported count is within half the allowed deviation of the target (2% or 8 tokens, whichever is larger). Longer prompts are sized from a fit made on 2k probes, so they are not probed at full length, and every request is checked against the allowed deviation. A request outside it fails.
- **Output length.** A request must produce exactly the workload's output tokens by `usage.completion_tokens`. A request that stops early fails, so a short answer is never averaged in as a fast one. Where the engine supports it, force the length with an engine field such as `--request-field ignore_eos=true`. These fields are recorded in the result's settings and cannot replace the fixed fields.
- **Cache policy.** Every session starts with a unique nonce, including calibration and warm-up, so no prefix is reused across sessions. Where the engine reports cached prompt tokens they must be zero, except on warm agent turns, and the result records whether the engine reports them at all.
- **Agent workflow.** Turn 1 sends the prefix cold. Turns 2 to 5 send the same prefix plus the earlier appended outputs and one new one, so most of each prompt is cacheable. A warm turn must reuse at least 90% of the prefix when the engine reports cached tokens. When it does not, warm turns must reach the first token within half the cold turn's time, or the instance fails. The result records the hit ratio, the cold and warm time to the first token, and their ratio. The workload's `prefill` is the cold turn, and its `ttft_median_seconds` is the warm turns.
- **Batch input.** A chat endpoint takes one conversation per request, so batching means concurrency. Each worker sends its requests one after another with no pause, and all workers start together. The aggregate output throughput is the output tokens of every request divided by the time from the first dispatch to the last completion, summed over repetitions, so ramp-up and ramp-down are included. Per-request decode speed under the same load is reported next to it, because aggregate throughput can rise while each user slows. A single request carrying several inputs is not measured here.
- **Timing.** All intervals use one monotonic clock at the client. Prefill seconds are the time from dispatch to the first output chunk, so they include queueing, transfer, and the first sampled token; processed input tokens are the reported prompt tokens minus cached ones. Decode throughput is the sum of N-1 over the sum of first-to-last chunk intervals, with N from `usage.completion_tokens`. It applies only when the engine sends at least 0.9 output chunks per token. Otherwise decode is "Not obtained" and the result says why, because multi-token chunks need a native definition that is never relabeled N-1.
- **Passes and spread.** The contract's warm-up and formal repetition counts are passed as `--warmup` and `--repetitions`. A workload instance in which any request fails its gates is excluded from that workload's metrics, and its pass is recorded as failed in the result's repetitions with the reason. `formal_repetitions` counts the formal passes in which every workload succeeded. Each workload reports its headline tokens per second for every repetition that counted and their sample standard deviation. Cold load is not measured here.
- **Resources.** Swap-out is the whole-machine delta over the formal passes and is measured only for a loopback endpoint. Peak memory is sampled only when `--memory-pid` names the engine process, and is the sampled resident size, which may not include GPU memory; otherwise it is "Not obtained".
- **Quality block.** `quality.application` counts formal requests that met their workload gates. It is not a correctness result and does not include conformance, which is its own result document.
- **Negative control.** Before every run the driver starts reference engines with known behavior. One has known prefill and decode rates, block prefix caching, and slot-limited concurrency: the timing must recover its rates within 30%, its aggregate throughput must rise with concurrency while the per-request speed falls, and a half-speed engine must read about half. A fast one must pass the 216k, 32k-depth, and agent workloads, with cache reuse visible. Six faults must each be caught: reported cache hits, early stops, missing usage, coalesced chunks, HTTP errors, and a missing prefix cache.

```sh
python3 evaluations/engine-throughput/scripts/throughput.py \
  --endpoint http://127.0.0.1:8080 --model MODEL --role candidate --engine-name NAME \
  --workloads prefill.in2k.out1,decode.in128.out256,agent.p32k.s256.t5,batch.c4.in512.out64 \
  --warmup 1 --repetitions 3 --evaluation-revision FULL_COMMIT_SHA \
  --artifact ENGINE_BINARY=SHA256 --engine-command "COMMAND THAT STARTED THE ENGINE" \
  --hardware-model HARDWARE --toolchain TOOLCHAIN --power-mode MODE --thermal-observations TEXT --exclusive-gpu \
  --output experiments/EXPERIMENT_ID/runs/RUN_ID/candidate-NAME.json
```

It needs Python 3.9 or newer and no packages. Omit `--workloads` to run every workload. Run it on the engine's machine against a loopback endpoint (a remote one needs `--allow-remote` and is recorded as a deviation), and pass a key with `--api-key-file`. The environment options describe what you observed; `exclusive-gpu` is your statement that nothing else used the GPU. The driver writes the result document and, next to it, a `.requests.evidence` file with every request's timings and gate outcomes. That file holds no prompts or model output, is referenced by hash as local-only evidence, and is not committed (the repository ignores `*.evidence`).

These shapes follow common engine benchmarks: fixed-length synthetic prompts and outputs (TensorRT-LLM's `trtllm-bench`, vLLM's random dataset), forced output length (`ignore_eos`), warm-up before measurement, bounded concurrency with aggregate throughput over the benchmark window (vLLM, GenAI-Perf), shared-prefix workloads (SGLang's generated-shared-prefix, vLLM's prefix repetition), and decode measured at a context depth (llama.cpp's `llama-bench -d`). Where this evaluation differs, it is stricter: a request that misses its length or cache gate fails instead of being averaged in.

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

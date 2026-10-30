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

- The tool or harness name and exact version that drives the endpoint under test.
- The datasets, each pinned by repository and the hashes of the files read, the exact task IDs, and the seed.
- Input/output limits, per-task timeout, request concurrency, cache policy, and sampling settings for the target model.
- The plan of a performance evaluation: its throughput workloads, its rule-scored benchmarks, and the sandbox for generated code.
- The scripts that carry out the evaluation, each with a role (driver, assertion evaluator, or dependency lock), a path inside the evaluation directory, and a content hash.

A definition is a `draft` or `released`. A released definition has every field resolved, and every script exists in the repository and matches its hash. A draft has unresolved fields and cannot be used for formal runs.

The experiment contract keeps only what depends on the experiment: the evaluation reference, the warm-up plan, and formal repetitions.

Evaluations in the repository at the time of writing (the commit you resolved is authoritative):

| Evaluation | Status | Result document | Purpose |
| --- | --- | --- | --- |
| `engine-evalscope` | released | `EvaluationResult` | EvalScope measurement of a chat endpoint: throughput first (prefill by prompt length up to 128k, decode by context depth, concurrency, multi-turn prefix reuse), then rule-scored HumanEval and GSM8K to show the engine still computes the model correctly. |

Earlier measurements with external drivers (the Infer.NET records) are prior evidence only: they used different workloads, timing boundaries, and a Pi coding-agent harness, and their correctness check did not meet this protocol.

When a script changes (a maintainer task in the repository), update its hash in the definition (for example with `shasum -a 256`). The repository tests fail until the hashes match.

## EvalScope evaluation

`engine-evalscope` measures an OpenAI-compatible chat endpoint with [EvalScope](https://github.com/modelscope/evalscope) in two parts. **Throughput** is the main result: it says how fast the engine serves the model. **Intelligence** is a check: it says the engine still computes the model correctly. EvalScope does the measuring and scoring. The repository fixes how it is invoked, pins it, and checks that what it reports means what this protocol says.

- **Pinned tool.** The definition names the EvalScope version (1.14.1), and `requirements.lock` pins it and every dependency by hash, for Python 3.10 or newer. The lock is hashed in the definition like a script. Install it into a clean environment (`uv venv --python 3.13 && uv pip install --require-hashes -r evaluations/engine-evalscope/requirements.lock`) and run the driver with that environment's Python. The driver refuses another EvalScope version.
- **Everything is in the plan.** The definition's `plan` lists every workload, benchmark, and the sandbox. The driver builds each `evalscope perf` and `evalscope eval` command from it, so an experiment cannot change a workload or a benchmark.

### Throughput

Each workload is an `evalscope perf` run at one or more closed-loop concurrency levels (`parallel`), with warm-up requests that EvalScope excludes. Prompts are EvalScope's random tokens of an exact length, and `ignore_eos` forces the output length. Lengths count tokens as the engine reports them.

| Workload | Shape | Measures |
| --- | --- | --- |
| `prefill.in2k.out1`, `in8k`, `in32k`, `in128k` | 2k, 8k, 32k, or 128k prompt tokens, one output token | Prefill speed by prompt length |
| `decode.in128.out256`, `in8k`, `in32k` | 128, 8k, or 32k tokens of context, 256 output tokens | Decode speed by context depth |
| `concurrency.in512.out64` | 1, 2, 4, and 8 concurrent requests of 512 input and 64 output tokens | Aggregate throughput and per-request speed under load |
| `multi-turn.in8k.t5` | Conversations of 5 turns that each add 8k tokens | Prefix-cache reuse as the context grows |

Here k means 1024 tokens. The run-level `prefill`, `decode`, and `client_ttft_median_seconds` are the single-stream workloads `prefill.in2k.out1` and `decode.in128.out256`. Every level is reported in the result's `throughput` list.

- **Definitions.** Prefill is processed input tokens (reported prompt tokens minus cached ones) over EvalScope's time to first token. Decode is output tokens minus one over its time per output token. Output throughput is the output tokens of all requests over the test duration, so ramp-up and ramp-down are included. All are ratios of sums over requests and passes, never means of per-request speeds.
- **Gates.** A level counts only if every request succeeded, prompts reached the target length (within 2% or 16 tokens), and every request produced exactly the target output length. A level that fails is excluded from the metrics, its pass is recorded as failed with the reason, and the metrics stay "Not obtained" rather than zero. The engine must report cached tokens as zero on unique prompts (above 1% fails the level); only multi-turn workloads reuse their own earlier turns, and their cache hit ratio and first-turn and later-turn time to first token are recorded.
- **No repeated prompts.** The random prompts are reseeded for every level and pass from a per-run salt that is recorded in the settings, so an engine cannot serve one from an earlier run's prefix cache.
- **Passes.** The contract's warm-up and formal repetition counts are `--warmup` and `--repetitions`: whole passes over the plan. A single formal pass is preliminary evidence. Each workload reports its headline tokens per second for every pass that counted, with their sample standard deviation. Cold load is not measured.
- **Resources.** Swap-out is the whole-machine delta over the formal passes and is measured only for a loopback endpoint. Peak memory is sampled only when `--memory-pid` names the engine process; it is the sampled resident size, which may not include GPU memory. Otherwise both are "Not obtained".

### Intelligence

Benchmarks are rule-scored only; no judge model is involved. The plan uses HumanEval (all 164 tasks, pass@1, the official tests executed in a Docker sandbox) and GSM8K (4-shot, the first 200 test questions, final-number match), at temperature 0 with a 4096-token output limit. Reasoning models should run with thinking disabled through `--request-field`.

- **Pinned data.** The datasets are the ModelScope files named in the definition, checked by SHA-256 and copied before use, because EvalScope edits the dataset folder it reads. `--dataset-dir` supplies local copies; the hashes are checked either way.
- **Sandbox.** Generated code runs in a container from a digest-pinned Python image with the network disabled, 1 GiB of memory, and 1 CPU. Docker is required.
- **What the score means.** It shows the engine did not break the model; it is not a ranking of models and not numerical equivalence. Each score carries its sample count and the standard error of a proportion. The experiment judges it against a baseline engine of the same model: a candidate passes when no benchmark falls below the best baseline score by more than two standard errors of the difference. The leaderboard applies that rule, and a baseline passes on verification alone because it defines the reference. State the rule in the contract's `quality_gate`.
- **Partial runs.** `--parts throughput` or `--parts intelligence` runs one part for development. The result records the deviation, and a missing intelligence block is "Not obtained", so the gate stays unverified.

### Negative control

Before every run the driver repeats its control through the same EvalScope pipeline, so a change in EvalScope's behavior shows up as a failed control. A reference engine with known prefill and decode rates, two decode slots, and a prefix cache must be recovered within 35%, its aggregate throughput must rise with concurrency, and its multi-turn workload must show prefix reuse. Three faults must each be caught: early stops, HTTP errors, and a missing prefix cache. An oracle engine that answers from the pinned datasets must score right answers 1 and wrong answers 0 on both benchmarks. Code that probes the network must run cleanly in the sandbox and must fail when the same probe runs with the network enabled; if that second half cannot be shown (for example the machine is offline), the result records that isolation was not demonstrated and `restricted_environment` is false.

```sh
python3 evaluations/engine-evalscope/scripts/evaluate.py \
  --endpoint http://127.0.0.1:8080 --model MODEL --tokenizer-path DIR_WITH_TOKENIZER_AND_CHAT_TEMPLATE \
  --role candidate --engine-name NAME --warmup 0 --repetitions 3 --evaluation-revision FULL_COMMIT_SHA \
  --artifact ENGINE_BINARY=SHA256 --engine-command "COMMAND THAT STARTED THE ENGINE" \
  --hardware-model HARDWARE --toolchain TOOLCHAIN --power-mode MODE --thermal-observations TEXT --exclusive-gpu \
  --output experiments/EXPERIMENT_ID/runs/RUN_ID/candidate-NAME.json
```

Use the locked environment's Python. The tokenizer directory must be the model's own, with its chat template, because EvalScope sizes prompts with it; a tokenizer of another model distorts every token count, and its hash is recorded. Run on the engine's machine against a loopback endpoint (a remote one needs `--allow-remote` and is recorded as a deviation), and pass a key with `--api-key-file`. The environment options describe what you observed; `exclusive-gpu` is your statement that nothing else used the GPU. The driver writes the result document and, next to it, a `.requests.evidence` file with every level's EvalScope summary, gate outcomes, and seeds. That file holds no prompts or model output, is referenced by hash as local-only evidence, and is not committed (the repository ignores `*.evidence`). `--logs-dir` keeps EvalScope's logs locally.

A full run of the real plan takes about half an hour on a slow engine, mostly the 128k prefill and the benchmarks. The tests exercise the control with `EVALSCOPE_TEST_TOKENIZER` (and optionally `EVALSCOPE_TEST_DATASETS`) set.

## Correctness gates

Numerical equivalence with a reference implementation is not required. The correctness gate is the intelligence check of `engine-evalscope`, and it is not evidence of numerical equivalence.

The intelligence check compares rule-scored benchmark results with a baseline engine of the same model. A candidate is not ranked on throughput unless it passes. Run generated programs in a restricted evaluation environment with no network and bounded resources, keep samples the model failed to answer in the denominator, and verify the scorer with a negative control. A small benchmark gives a wide standard error, so a pass shows only that the engine is not badly broken.

## Measurement

Run baselines and candidates serially on the same device under documented conditions. Separate cold load/compilation, warm-up, and steady state. Preserve every formal repetition and failure; report variability across repetitions. A single cohort is preliminary evidence, not a stability study.

Collect per-request native timings, client observations, input/output token counts, cache hits, request IDs, actual runtime builds/artifact hashes, and sampling coverage. A checkout commit does not prove the deployed executable's identity. Reconcile request counts and token totals with the harness before reporting complete metrics.

- Prefill throughput: sum of processed input tokens divided by sum of measured prefill seconds; define whether queueing, transfer, and state import are included. Cached tokens are identified separately.
- Decode throughput: sum of N−1 generation intervals divided by sum of first-to-last token durations. Requests with fewer than two tokens have no such throughput. Engines reporting command-level tokens/time or speculative multi-token emissions require their native definition to be reported separately; do not relabel it N−1.
- Client TTFT: monotonic time from request dispatch to first valid text/tool output. Ignore role-only, heartbeat, and usage events. Disclose proxy boundaries and observation overhead.
- Resources: sampled memory allocation/footprint with definition and interval, memory pressure, whole-machine swap-out delta over bracketed boundaries, power/thermal conditions, and failures. Do not attribute whole-machine paging to a process without evidence.

Aggregate throughput as ratios of sums, not an arithmetic mean of request speeds. Do not derive prefill/decode from application wall time. Missing metrics are “Not obtained”, not zero. Use monotonic clocks on a common observer for end-to-end intervals; do not subtract uncalibrated cross-host timestamps.

## Results

Each engine measurement is one result document, of the kind the definition names in `result_schema`. A performance evaluation emits an `EvaluationResult`. It pins the evaluation reference it ran, records the observed environment (which may differ from the contract, so deviations are written down), identifies the deployed runtime by artifact hashes, and holds the settings used, every repetition including failures, run-level headline metrics, the throughput of every workload level, resources, and the intelligence scores with their negative-control verdict. Per-request records stay in a hashed evidence file it references. The leaderboard lists only results of evaluations that exist at the current commit; records pinned to a retired evaluation stay in the repository as history and are named as retired, not dropped.

An experiment's run record lists result documents by path and hash and must cite the same evaluation reference as its contract. Comparison, SOTA, and autonomy claims belong to the experiment protocol.

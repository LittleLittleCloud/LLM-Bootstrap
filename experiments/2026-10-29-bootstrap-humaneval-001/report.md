# Experiment: 2026-10-29-bootstrap-humaneval-001

Status: **Completed**. Campaign completeness: **Passed**. Official assertions: **60/60 (100%)**, with **20/20 in each of three formal repetitions**. This is the fixed 20-task Pi-agent evaluation, not full 164-task model pass@1.

## Question and frozen contract

The user requested HumanEval and identified that the old 4096-token window may be insufficient. The repository-owned Pi evaluation advertises 32768 context and reserves up to 4096 output tokens on each request. A nonempty prompt plus that reserved output is rejected by the original 4096 total-token guard. This supplementary quality goal has its own frozen contract; the previously submitted 4k synthetic-throughput experiment is unchanged.

[Contract](contract.json): frozen `2026-10-29T16:42:37-07:00` at project commit `ac310c17037fb782d1e6d918ea7ba2b8b4df205a`, SHA-256 `aabd0cecf66125e7987f1846f9a02575fb4df7704bc79bdae4daaa77f70c8f17`. The [freeze commit](https://github.com/LittleLittleCloud/llm-bootstrap-qwen3.6-35b-dotnet-metal/commit/ac310c17037fb782d1e6d918ea7ba2b8b4df205a) is retained on the public contract-history branch and precedes context implementation. No contract amendment was made. Starting engine source is `f51d0ac885758e3b1735a7549e3a35497d472f1b`; main merge `70ddcb30188bcfd2d12ca4e81f3bb18bbba80dfc` has identical content. The allowed reuse is this existing independently built .NET + Metal engine; external inference backends remain prohibited as the candidate backend.

Skills revision is `9b71eb126c862a8c185272e5b68a26a55e953cb9`; exact SOP/protocol/plan/build/evaluate and builder-task hashes are in the contract. The local builder-task SHA-256 is `d290c4a57308741115d302e3941e7b70156aa68a76459245ab8c828423875303`. Builder inference remains OpenAI-hosted GPT-6-family Codex. Exact deployment identifier, provider sampling settings and desktop package hash were not exposed and remain unavailable; CLI 0.157.0 was observed separately. No self-hosting, autonomy or recursive-improvement claim is made.

Hardware: Apple M5 Pro, 20 GPU cores, 48 GiB unified memory; macOS 26.6.2 (25G83), Darwin 25.6.0, Metal 4. Candidate uses .NET SDK 10.0.100/.NET 10, Apple clang 21.0.0 and original FP32 Metal kernels with safe math. The native bridge calls Foundation/Metal/libc only. CPU work is host tokenization/API/control/sampling; model computation uses Metal. Observed recommended working set is 44,023,414,784 bytes (41 GiB), maximum buffer 30,150,672,384 bytes. AC/powermode=2 was observed. No OS power/memory setting was changed. Competing inference models ran serially; general GPU/CPU exclusivity and quantitative thermal stability are not claimed.

Model: official `Qwen/Qwen3.6-35B-A3B-FP8` at `95a723d08a9490559dae23d0cff1d9466213d989`, with all source weight hashes in the contract/manifest. Packed E4M3 and 128x128 BF16 scales are unchanged; excluded BF16 tensors retain source values and are promoted for FP32 math. Activations/accumulation, KV and recurrent/convolution states are FP32. Tokenizer SHA-256 is `5f9e4d4901a92b997e463c1f46055088b6cca5ca61a6522d1b9f64c4bb81cb42`; chat-template SHA-256 is `e84f32a23fdda27689f868aa4a1a5621f41133e51a48d7f3efcbea2839574259`. Full 40-layer text inference, greedy sampling, thinking off, no vision/MTP/speculation or CPU model fallback. The served window for this campaign is 32768 with a separate 4096 output-token cap, unscaled text RoPE and request-isolated state reset.

Evaluation: `humaneval-20-pi` at `9b71eb126c862a8c185272e5b68a26a55e953cb9`, definition SHA-256 `933285b68d72f20497ce7cd6c5d8d53856f76aa50bb06b4c16bf187e34623ae9`. A fresh detached checkout was obtained and all six HumanEval scripts plus nine conformance scripts were hash-verified; no evaluator was changed. Dataset is official HumanEval at `b9453e8f1865df0a0057a1383767caa400acfbcf`, file SHA-256 `b796127e635a67f93fb35c04f4cb03cf06f38c8072ee7cee8833d7bee06979ef`. The exact 20 task IDs are retained in the raw result. One warm-up pass covers the first two tasks and is excluded; three formal passes each cover all 20. No `--tasks` subset was used for the candidate.

No fixed time/token/API-cost/hardware-hour cap was supplied; the user stops on request. The predeclared stopping rule is to complete this finite campaign and report all outcomes, not tune until a desired score. No additional numeric footprint/swap cap was imposed and no new quality-rate or HumanEval speed threshold was invented. The contract's 60-task coverage threshold denotes measurement completeness only. In this observed run, all selected assertions also passed.

## Execution and evidence

Run `2026-10-29-candidate-001`: `2026-10-29T23:46:34+00:00` to `2026-10-29T17:28:13.425325-07:00` (UTC offset included; local timezone America/Los_Angeles). Runtime/source is `a2d03f89dd5caa0dbf3f80cd65e4cc86c7d41870`, committed before successful build. The embedded DLL version was verified. [Unedited evaluator result](runs/2026-10-29-candidate-001/candidate-bootstrap-dotnet-metal-fp8.json), SHA-256 `0bd7606030c4bd4f66555fa479d2cf95063f0a0d8d664a12526ac26d5596c406`, retains exact artifact hashes, settings, commands, repetitions and measurements. Its paired [run record](runs/2026-10-29-candidate-001/run.json) pins the frozen contract.

- DLL SHA-256: `2b8ee2574d02a7f2b7e9e9e674da4fbd3734fec7a4b98cd0891f56c1773945f5`.
- Native bridge SHA-256: `87ed6a0113616768bf9df3c92a9c70405cc900e21e98240b0395463fa2077840`.
- Runtime shader SHA-256: `75cb9c5165f6b44fd30025b93758d830acccc7a4812900136b1deab54e32cd17`.

The [independent context implementation PR](https://github.com/LittleLittleCloud/llm-bootstrap-qwen3.6-35b-dotnet-metal/pull/2) adds `--context-window` with default 4096 and range 512–32768, shares the configured bound between API and engine checks, and allocates KV/attention buffers accordingly. A 2D attention grid avoids overflow of the former flattened integer thread count at longer positions. Hidden dimensions, weights, precision and the evaluator remain unchanged. Context and evaluation changed together, so this is not attribution to a single optimization.

Implementation checks passed 1249 kernel/context cases (including independent CPU dot products and causal masks near the 32768 boundary), six reference tokenizer fixtures and seven user-literal cases. A real-model 4226-token public arithmetic fixture returned `4` and rejected overflow. Logical Metal allocation after that smoke was 39,248,379,904 bytes (about 36.55 GiB); this is not physical residency. Context-smoke SHA-256 is `ea44d9561059acb9f70c9660eb2b74648f685f722823ca6b930e23bf29418b76`.

Complete `engine-api-conformance` ran first at 32768 context: 60 passed, one advisory skipped, zero failures/errors, verified negative control. The incremental-stream advisory had fewer than four completion tokens and was skipped, not counted as a pass. Conformance SHA-256 is `305f1be307ea611cf185845eaf4a7adfbfcdbf7eed847b16c830b8d6bb830b6e`; deployed identity/check record SHA-256 is `7c1866e04b11cdb9641abd7c0aa5a233c6bc939dedb4252c48756d64330855d2`. Actual DLL/native/shader identities agree between conformance and HumanEval.

Pi 1.4.0 starts a fresh task/workspace/agent directory with minimal environment, thinking off, `read,write,bash,edit`, and no extensions/MCP/context files/compaction/retries. Pi exposes no sampling option; this engine's default is greedy. The tests never reach Pi or its workspace. Official assertions run after each cohort in `python@sha256:5fb4bc53dd0180955e31e5245b648bbb24a4ac4ab03a1de81513642325220bcd` containers, network disabled, read-only root/mount, no capabilities, unprivileged user, CPU/memory/process limits and 30 seconds. Task timeout remains 300 seconds. Positive/negative sandbox controls and all injected faults verified before the real run.

The raw per-task/per-request evidence (no prompts/solutions/output) is local-only, SHA-256 `28239ff035e3ad77f2225db29d1926e799e5538a222dfb668fd7f28a974c08f2`. Raw Pi events, generated solutions and other diagnostics remain local-only under ignored evidence; they are not published. Access is controlled by the repository owner, not promised as a public download. The original 4k service was stopped while idle for serial evaluation; no two 35B inference processes were run together.

The prior independent MLX-LM baseline (`6b572ab1b531dd8fd2d13f6f36a89c2eccda18ea`, generic adapter `6992293876fe2e666923f7b19d17747611844a34`) uses separately pinned affine8/group64 weights and BF16 defaults. At 32k it passed complete conformance then a one-task HumanEval/156 setup preflight, 1/1 official assertions. Preflight result SHA-256 is `6d7f17318d25b610499a0f0ab594b5d836931a9ca926b1daacbad02dbc46eaaa`. That subset validates plumbing only; it is not a full baseline quality estimate or precision-matched speed comparison. No quality/speedup/SOTA comparison is derived from it.

Human interventions selected the task and identified the context gap; exact message timestamps and a complete costed trajectory are unavailable. No human implementation edits were observed. Builder token/API cost and separately metered hardware hours are **Not obtained**. Task/application durations below do not substitute for those costs.

## Results

| Formal repetition | Official assertions | Proxy requests | Tool calls | Summed Pi task wall seconds |
| --- | ---: | ---: | ---: | ---: |
| 1 | 20/20 | 89 | 69 | 793.868 |
| 2 | 20/20 | 87 | 67 | 760.400 |
| 3 | 20/20 | 85 | 65 | 770.750 |
| Total | 60/60 | 261 | 201 | 2325.019 |

All 60 formal tasks completed cleanly, produced syntactically valid solutions, passed their official assertions and reconciled with the proxy. There were no missing solutions, invalid syntax cases, timed-out tasks, API errors or incomplete formal passes. The two warm-up tasks also finished cleanly but do not contribute to the score. Each of the three formal passes succeeded. All failures would have remained in the denominator; none occurred in this cohort.

| Metric / resource | Observation | Definition / limitation |
| --- | ---: | --- |
| Processed input tokens | 596671 | Across 261 formal proxy requests, uncached |
| Output tokens | 42584 | Sum of engine usage on those requests |
| Observed input span | 1803–3632 tokens | Includes engine chat template; the campaign does not establish semantic quality at a 32k input length |
| Proxy prefill tokens / seconds / rate | 596671 / 2304.5387 / 258.911 tokens/s | Dispatch to first valid output; tool requests buffer generated XML before protocol parsing, so this includes generation time |
| N-1 decode | Not obtained | 0.0052 chunks/token is below the repository 0.9 gate; no native/prior number is substituted |
| Proxy TTFT median | 8.001674 seconds | Across formal model requests |
| Mean 20-task application time | 775.006 seconds | Mean summed Pi launch-to-exit task times over the three succeeded passes; assertions excluded |
| Per-repetition time sample SD | 17.135 seconds | One local cohort; not a cross-day stability study |
| Sampled engine RSS peak | 2.181 GiB | Every 0.5 seconds; may exclude GPU memory and is not model footprint |
| Whole-machine swap-out delta | 1257701376 bytes / 1.1713 GiB | Measured bracket only; not attributed to this engine and not evidence of swap-free execution |
| Full physical GPU residency / thermal traces | Not obtained | Logical buffer allocation is reported separately |

## Interpretation and disposition

- **Passed:** fixed 20-task coverage in all three formal rounds (60 evaluated task-runs); complete API gate and verified sandbox/negative controls; all official assertions (20/20, 20/20, 20/20); usage/request reconciliation; unchanged official FP8/FP32 path and OS limits.
- **Not applicable as numeric gates:** extra memory/swap caps and new HumanEval speed/quality floors. The observed nonzero whole-machine swap delta is disclosed, not hidden.
- **Not obtained / not claimed:** HumanEval N-1 decode, numerical equivalence, full-164-task model pass@1, long-input semantic quality near 32k, exhaustive baseline/SOTA coverage, autonomous development, recursive improvement or self-hosting.

Observed prompts remained below 4096, but reserving the evaluation's 4096 output budget makes the original 4096 total-token check incompatible; the largest observed prompt plus reserved output was 7728. The server was configured at the evaluation's 32768 window. Boundary checks and the 4226-token smoke are separate implementation evidence, not a claim that this HumanEval cohort used 32k prompts.

Do not compare 258.911 proxy prefill directly as a controlled engine speedup with the old 516.571 fixed-shape result. Workload, window, tool behavior and timing boundaries differ. Pi may make multiple calls and repair/test its solutions, so this 60/60 result is agent-level task success, not standalone model pass@1. The underlying 20 tasks repeat with fresh nonces; three repetitions do not create 60 distinct benchmark problems.

Code adoption and result publication are separate. The context PR is open and unmerged; this report does not authorize a merge. The previous published 4k records remain unchanged.

## Feedback for future experiments

- Inspect the harness context and reserved output budget before running. The old window would reject all nonempty requests reserving 4096 output tokens; a CLI context option and shared checks resolve that incompatibility without deleting safeguards.
- Review cache allocations and grid integer dimensions together. Raising only a constant would leave the flattened prefill attention dispatch vulnerable to overflow. Independent near-32k dot products/mask tests and a >4k real-model smoke catch distinct failure classes.
- Initial context source `322777e3cf32135be2ee912927c076f8be685354` failed compilation (nested workspace instance reference and int-to-uint strides). A non-fail-fast shell then invoked the previous DLL: its old checks/help output were explicitly invalidated and never used as formal evidence. Source `a2d03f8` fixed the compile errors; fail-fast orchestration, embedded version verification and deployed hashes prevented stale-build attribution. Preserve this failed development attempt.
- Incremental tool-call streaming remains a separate improvement: buffering XML until parsing preserves tool semantics but hides generation in TTFT and prevents N-1 decode measurement. Do not weaken the evaluator chunk-density gate to obtain a number.
- Distinguish task completion, syntax, assertion correctness and complete usage accounting. This campaign passed all four, while the index quality gate should continue to use official assertions rather than mere HTTP success.
- Baseline setup subsets, unmatched affine8/BF16 versus official FP8/FP32, one local hardware cohort, repeated task IDs and observed input lengths limit generalization. No stronger quality or performance claim follows from this run.
- Keep complete raw task/solution evidence privately and expose hashes/access limitations. A result's exact CLI may include reviewed local workspace/executable paths; future launches can use relative artifact paths to reduce metadata exposure without editing emitted result bytes.

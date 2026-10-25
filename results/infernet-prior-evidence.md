# Prior evidence: Infer.NET and a Splash reference

These measurements motivated LLM Bootstrap. They are imported as cited historical observations, not as experiments executed using this project's skills. Measurement date: **2026-10-24, America/Los_Angeles**. No builder trajectory, complete human-intervention record, or self-hosting transition is established by these reports.

Source snapshot: Infer.NET documentation commit `4ca29eed1a2acb8a870d33e980dce37dfbc1b7e3`. This is the documentation snapshot, not either engine's tested runtime SHA.

## Common workload

- Apple M5 Pro, 20-core GPU, 48 GiB unified memory, AC / High Power; no Windows GPU participation.
- Target: `mlx-community/Qwen3.6-35B-A3B-8bit`, revision `e06a74e6236a60c8367e1a3214e83d8b61b637b0`, affine8/group64.
- Pi 1.4.0, fixed HumanEval 20, seed 0, context limit 32768, per-request output limit 4096, per-task timeout 300 seconds, serial requests, no prefix-cache hits reported.
- HumanEval revision `b9453e8f1865df0a0057a1383767caa400acfbcf`; compressed dataset SHA-256 `b796127e635a67f93fb35c04f4cb03cf06f38c8072ee7cee8833d7bee06979ef`.
- A 32K configured window does not mean requests each contained 32K tokens. These are agent task evaluations with multiple model calls; assertion success is not single-sample model pass@1.

## Infer.NET fully local

Run: `issue58-m5pro-local-human20-20261024`. Tested engine SHA: `87c2b7dcaf4a418dcb18707e1913562717b43cdc`. FP32 KV/state, fused FP32 decode, no speculative decoding, managed prefill chunk 32, scratch 128, Metal residency enabled.

| Metric | Observed |
| --- | ---: |
| Official task assertions | 20/20 |
| Requests / worker timing coverage | 107/107 |
| Input / output tokens | 243,663 / 19,104 |
| Prefill duration / throughput | 908.496 s / 268.205 tok/s |
| Decode intervals / duration / throughput | 18,997 / 285.955 s / 66.434 tok/s |
| Client TTFT median | 10,914.875 ms |
| Pi cohort duration | 1,202.992 s |
| Sampled peak Metal allocation | 34.730 GiB |
| Whole-machine cohort swap-out delta | 2.013 GiB |

Decode uses N−1 first-to-last output intervals. Client TTFT includes two observation forwards and starts before forwarding; dispatch from Pi to the observer is excluded. The run is not a no-swap result. Loading/warm-up had another 8.688 GiB whole-machine swap-out, separate from the cohort. The original assertion attempt failed to mount relative paths, executed no tasks, and was retained; evaluating the same unmodified solutions with absolute paths passed all 20. This was not answer regeneration or task selection.

[Full report](https://github.com/LittleLittleCloud/Infer.NET/blob/4ca29eed1a2acb8a870d33e980dce37dfbc1b7e3/docs/EXPERIMENT-58-M5PRO-HUMAN20-20261024.md) · [Public performance summary](https://github.com/LittleLittleCloud/Infer.NET/blob/4ca29eed1a2acb8a870d33e980dce37dfbc1b7e3/docs/evaluations/issue58/performance.json) · [Evidence hashes](https://github.com/LittleLittleCloud/Infer.NET/blob/4ca29eed1a2acb8a870d33e980dce37dfbc1b7e3/docs/evaluations/issue58/evidence.json)

## Splash independent reference

Run: `issue61-splash-human20-resident40g-20261024`. Splash 1.4.0 source SHA: `1482f6bbc2abf12375332725302019594150b6cb`. Observer SHA: `b0bad3155468961ca0cdf6ee55cb710b515dfd7c`. Evaluation driver source SHA: `ce151663b4182bcb8371c9d0160fa20b9f8b1274`.

Q8 KV, FP32 recurrent state, full target residency, expert streaming off, DFlash2 enabled. Draft: `incoai/Qwen3.6-35B-A3B-DFlash2`, revision `51ef7b6923ad6c14cb1bb41c37a9041446496ab6`. The user raised `iogpu.wired_limit_mb` to `41984`; Splash used `--max-memory 40G` and observed a 41 GiB Metal recommended working set. The limit was restored to default after the experiment.

| Metric | Observed |
| --- | ---: |
| Official task assertions | 20/20 |
| Requests / native timing coverage | 107/107 |
| Input / output tokens | 333,970 / 22,814 |
| Native command prefill duration / throughput | 108.905243 s / 3,066.611 tok/s |
| Native command decode duration / throughput | 153.202860 s / 148.914 tok/s |
| Client TTFT median | 850.675 ms |
| Pi cohort duration | 270.630 s |
| Sampled peak Metal allocation | 35.974 GiB |
| Whole-machine cohort swap-out delta | 256.25 MiB |

Native command timing is distinct from Infer.NET's N−1 decode metric; equivalent per-token generation clocks were not obtained. Speculative output may emit multiple tokens per event. Initial startup under the default budget failed with `kv_pool_does_not_fit` before Ready: zero formal requests, no throughput or task pass rate obtained. The later full cohort required the changed system memory limit. Neither failure nor paging is omitted from the source report.

[Full report](https://github.com/LittleLittleCloud/Infer.NET/blob/4ca29eed1a2acb8a870d33e980dce37dfbc1b7e3/docs/EXPERIMENT-61-SPLASH-HUMAN20-20261024.md) · [Public performance summary](https://github.com/LittleLittleCloud/Infer.NET/blob/4ca29eed1a2acb8a870d33e980dce37dfbc1b7e3/docs/evaluations/issue61/performance-resident40g.json) · [Workload manifest](https://github.com/LittleLittleCloud/Infer.NET/blob/4ca29eed1a2acb8a870d33e980dce37dfbc1b7e3/docs/evaluations/issue61/manifest-resident40g.json) · [Official assertions](https://github.com/LittleLittleCloud/Infer.NET/blob/4ca29eed1a2acb8a870d33e980dce37dfbc1b7e3/docs/evaluations/issue61/functional-resident40g.json)

## What this evidence supports

The records demonstrate that the target model can serve a real Pi coding workload locally and pass this fixed set of application assertions. They supply a useful starting workload and expose meaningful performance and memory constraints.

They do not demonstrate that an LLM autonomously wrote either engine, reached platform SOTA, or continued development through its own generated engine. Different KV precision, speculative decoding, memory budgets, request trajectories, and timing definitions prevent attributing the difference to an individual optimization or presenting a controlled engine speedup ratio. No 128K acceptance or comprehensive cross-backend numerical validation follows from these 20 tasks.

Public reports and structured summaries are available through the links above. Full raw logs, generated programs, and Pi sessions were retained locally by the original project; the original reports identify their locations and evidence hashes. They are not public downloads. This project has not rerun the measurements or independently audited those private artifacts.

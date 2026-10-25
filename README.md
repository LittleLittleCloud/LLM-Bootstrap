# LLM Bootstrap

**Can an LLM build its own inference engine?**

LLM Bootstrap is a collection of skills for agents that build inference engines. Each experiment fixes a **hardware + target model + agent harness + workload** configuration, supplies the skills and a measurable goal, and studies whether an LLM can build an engine competitive with the strongest verified baselines on that specific platform.

The engine may specialize aggressively for the chosen hardware and model. General-purpose engine coverage is not the objective. Platform-specific state-of-the-art performance is the research target, not an established result.

## Motivation

An LLM already runs on a substantial inference stack. Can it use that initial capability to write, validate, profile, and optimize the stack that will run its next inference?

Infer.NET motivated this project by providing a concrete local engine and real application measurements. LLM Bootstrap separates the reusable experimental method from any particular implementation, language, or hardware backend. A run may produce C++, Rust, C#, Metal, CUDA, or another implementation suited to its declared platform.

The research has three levels:

1. **Build:** produce a functioning engine with validated model execution.
2. **Optimize:** use measurements to approach or exceed strong baselines under a fixed correctness and resource contract.
3. **Self-host:** run the builder LLM through the resulting engine and continue development, preserving a traceable record of the transition.

The initial LLM, operating system, compiler, hardware, and permitted libraries are declared inputs. “Autonomous” refers to implementation and optimization decisions within that environment. Human interventions and pre-existing engine code are recorded. If the builder LLM differs from the target model, the experiment studies engine construction; it does not yet demonstrate self-hosting.

## What is in this repository?

| Path | Purpose |
| --- | --- |
| [skills/bootstrap-plan](skills/bootstrap-plan/SKILL.md) | Freeze the experiment contract and baseline comparison before implementation. |
| [skills/bootstrap-build](skills/bootstrap-build/SKILL.md) | Build and optimize the engine through correctness checks and profiling. |
| [skills/bootstrap-evaluate](skills/bootstrap-evaluate/SKILL.md) | Evaluate complete runs and report performance, quality, resources, and autonomy. |
| [docs/experiment-protocol.md](docs/experiment-protocol.md) | Shared experiment definitions and claim requirements. |
| [experiments/m5pro-qwen36-pi/example.json](experiments/m5pro-qwen36-pi/example.json) | Unrun starting configuration based on the motivating workload. |
| [experiments/TEMPLATE.md](experiments/TEMPLATE.md) | Experiment plan and result record. |
| [results/infernet-prior-evidence.md](results/infernet-prior-evidence.md) | Sourced prior results and their limits. |

These are agent instructions and experiment templates. This repository does not yet ship an inference engine, an automated experiment runner, or a validated SOTA result.

## Usage

### 1. Give the agent the skills

Clone the repository and make the three skill directories available through your agent harness's supported skill-loading mechanism. Alternatively, provide their `SKILL.md` files and the linked protocol directly as context. Keep the repository accessible so relative references resolve. Harness integration varies; no Pi auto-discovery integration is claimed here.

```sh
git clone https://github.com/LittleLittleCloud/LLM-Bootstrap.git
cd LLM-Bootstrap
mkdir -p experiments/my-run
cp experiments/m5pro-qwen36-pi/example.json experiments/my-run/config.json
cp experiments/TEMPLATE.md experiments/my-run/record.md
```

### 2. Fix the experiment and goal

For example: **Apple M5 Pro, 48 GiB + Qwen3.6-35B-A3B 8bit + Pi 1.4.0**, with a fixed HumanEval workload and explicit correctness, memory, and latency requirements. This tuple identifies a starting point; it is insufficient until revisions, builder identity, baseline settings, budgets, and thresholds are filled in.

The example deliberately contains unresolved fields and `status: draft-not-run`. Fill them before running; it is a planning template, not an executable configuration. Distinguish the harness driving engine development from the harness evaluating the resulting endpoint, even if both use Pi.

Supply a task such as:

> Read skills/bootstrap-plan/SKILL.md and define experiments/my-run/config.json and record.md. Then use bootstrap-build and bootstrap-evaluate to build a local inference engine specialized for this machine and target model. Measure it against the baselines named in the contract. Preserve correctness and resource limits; retain failed attempts and record every human intervention. Work within the declared budget. Attempt self-hosting only if the builder identity and model support make it possible and it is included in the experiment scope.

### 3. Build, measure, and retain evidence

Start from a declared scaffold or empty engine directory. Keep the skills revision, implementation commits, commands, profiles, correctness results, per-request timings, failures, and agent trajectory. Run competing engines serially on the same hardware. Publish results with exact configurations and evidence access limitations; do not call unmatched measurements an optimization speedup.

Use feature branches and pull requests for project changes. Merge requires explicit maintainer authorization. Preparing this repository does not start a hardware experiment.

## Known experimental results

These are **prior application measurements from Infer.NET**, measured on 2026-10-24. They were not produced by the skills in this repository and do not establish autonomous construction or self-hosting.

Both records use M5 Pro / 48 GiB, `mlx-community/Qwen3.6-35B-A3B-8bit` at revision `e06a74e6236a60c8367e1a3214e83d8b61b637b0`, Pi 1.4.0, and the same fixed 20 HumanEval tasks.

| Prior run | Official assertions | Reported prefill | Reported decode | Pi task time |
| --- | --- | --- | --- | --- |
| [Infer.NET, fully local](https://github.com/LittleLittleCloud/Infer.NET/blob/4ca29eed1a2acb8a870d33e980dce37dfbc1b7e3/docs/EXPERIMENT-58-M5PRO-HUMAN20-20261024.md) | 20/20 | 268.205 tok/s | 66.434 tok/s, N−1 intervals | 1,202.992 s |
| [Splash, full residency](https://github.com/LittleLittleCloud/Infer.NET/blob/4ca29eed1a2acb8a870d33e980dce37dfbc1b7e3/docs/EXPERIMENT-61-SPLASH-HUMAN20-20261024.md) | 20/20 | 3,066.611 tok/s, native command timing | 148.914 tok/s, native command timing | 270.630 s |

**These rows are not a controlled engine speedup comparison.** Infer.NET used FP32 KV/state and no speculative decoding; Splash used Q8 KV, FP32 recurrent state, and a DFlash2 draft model. Work generated different request token totals, timing boundaries differ, and Splash required a raised GPU memory limit. Both recorded whole-machine swap-out. Splash first failed to start under the default budget; that failure is retained in the source record.

See [prior evidence](results/infernet-prior-evidence.md) for versions, metric definitions, resource observations, and public evidence links. HumanEval task correctness is not cross-backend numerical equivalence or long-context acceptance. **No experiment under the LLM Bootstrap protocol has been completed yet; platform SOTA and self-hosting remain unverified.**

## What counts as success?

Success is defined per experiment before tuning: quality and correctness gates, prefill/decode and client latency objectives, memory constraints, and a fixed compute/time budget. Report the gap to named, dated baselines alongside agent cost and human assistance.

A SOTA claim requires a credible search for strong current baselines, matched conditions or clearly separated comparison tracks, reproducible measurements, and stated workload boundaries. A result on one model and platform supports that configuration only. See the [protocol](docs/experiment-protocol.md) for the full reporting contract.

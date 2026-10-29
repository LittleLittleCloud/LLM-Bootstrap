# LLM Bootstrap

**Can an LLM build its own inference engine?**

LLM Bootstrap is a skills plugin for agents that build inference engines, packaged for both **Agent Plugins 1.0** and **Claude Code plugins**. Both formats load the same three skills and bundled experiment resources. Each experiment fixes a **hardware + target model + agent harness + workload** configuration, supplies the skills and a measurable goal, and studies whether an LLM can build an engine competitive with the strongest verified baselines on that specific platform.

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
| [plugin.json](plugin.json) | Agent Plugins 1.0 manifest; portable skills are discovered from the shared skills directory. |
| [.claude-plugin/plugin.json](.claude-plugin/plugin.json) | Claude Code manifest using the same skills and resources. |
| [.claude-plugin/marketplace.json](.claude-plugin/marketplace.json) | Single-plugin marketplace for installation and updates. |
| [skills/bootstrap-experiment-sop](skills/bootstrap-experiment-sop/SKILL.md) | Run a new or derived experiment end to end with explicit gates between stages. |
| [skills/bootstrap-plan](skills/bootstrap-plan/SKILL.md) | Freeze the experiment contract and baseline comparison before implementation. |
| [skills/bootstrap-build](skills/bootstrap-build/SKILL.md) | Build and optimize the engine through correctness checks and profiling. |
| [skills/bootstrap-evaluate](skills/bootstrap-evaluate/SKILL.md) | Evaluate complete runs and report performance, quality, resources, and autonomy. |
| [docs/experiment-protocol.md](docs/experiment-protocol.md) | Shared experiment definitions and claim requirements. |
| [docs/evaluation-protocol.md](docs/evaluation-protocol.md) | Repository-owned evaluation, correctness gates, and measurement definitions. |
| [evaluations/](evaluations/engine-api-conformance/evaluation.json) | Evaluation definitions and scripts owned by this repository. `engine-api-conformance` is released; `humaneval-20-pi` is a draft without scripts. |
| [schema/evaluation-protocol.openapi.json](schema/evaluation-protocol.openapi.json) | OpenAPI 3.1 schemas for evaluation definitions and result documents; structural checks only. |
| [schema/experiment-protocol.openapi.json](schema/experiment-protocol.openapi.json) | OpenAPI 3.1 schemas for the contract and run record; structural checks only. |
| [schema/resolve-contract.mjs](schema/resolve-contract.mjs) | Dependency-free resolver that merges a derived contract onto its pinned base. |
| [experiments/m5pro-qwen36-pi/example.json](experiments/m5pro-qwen36-pi/example.json) | Unrun starting configuration based on the motivating workload. |
| [experiments/TEMPLATE.md](experiments/TEMPLATE.md) | Experiment plan and result record. |
| [docs/prior-evidence.md](docs/prior-evidence.md) | Sourced prior results and their limits. |
| [docs/plugins.md](docs/plugins.md) | Installation, compatibility, local development, and validation. |

The plugin contains agent instructions and experiment templates, not executable hooks or MCP servers. This repository does not yet ship an inference engine, an automated experiment runner, or a validated SOTA result. Installing the plugin does not run an experiment or authorize machine changes.

## Usage

### 1. Install the plugin

**Agent Plugins / VS Code:** run **Chat: Install Plugin from Source** and enter `https://github.com/LittleLittleCloud/LLM-Bootstrap.git`, or select a local checkout of this branch while developing. Enable agent plugins if required by the client. A supporting client discovers the root [manifest](plugin.json) and the three skills automatically.

**Claude Code:** add `LittleLittleCloud/LLM-Bootstrap` with `/plugin marketplace add`, then install `llm-bootstrap@llm-bootstrap-marketplace` with `/plugin install`. For an unpublished local checkout, start Claude Code with `claude --plugin-dir /absolute/path/to/LLM-Bootstrap` instead.

Remote installation uses the published revision, not unpushed local changes. See [the plugin guide](docs/plugins.md) for complete commands, prerequisites, and verification. Start a fresh session in your **experiment project**, not the plugin cache. Invoke `bootstrap-plan` from the client's skill menu; in Claude Code it is `/llm-bootstrap:bootstrap-plan`. `bootstrap-build` and `bootstrap-evaluate` follow the same naming pattern.

Other harnesses may consume the skills directly if they preserve the entire repository layout. Copying only the skill files loses their shared resources. No Pi plugin auto-discovery integration is claimed here.

### 2. Fix the experiment and goal

For example: **Apple M5 Pro, 48 GiB + Qwen3.6-35B-A3B 8bit + Pi 1.4.0**, with a fixed HumanEval workload and explicit correctness, memory, and latency requirements. This tuple identifies a starting point; it is insufficient until revisions, builder identity, baseline settings, budgets, and thresholds are filled in.

The example deliberately contains unresolved fields and `status: draft-not-run`. Fill them before running; it is a planning template, not an executable configuration. Distinguish the harness driving engine development from the harness evaluating the resulting endpoint, even if both use Pi.

Supply a task such as:

> Use bootstrap-plan to copy the bundled example and record template into a new experiment directory in my project workspace, then define and freeze the contract there. Do not edit the installed plugin. After the essential fields and execution authorization are resolved, use bootstrap-build and bootstrap-evaluate to build a local inference engine specialized for this machine and target model. Measure it against the baselines named in the contract. Preserve correctness and resource limits; retain failed attempts and record every human intervention. Work within the declared budget. Attempt self-hosting only if the builder identity and model support make it possible and it is included in the experiment scope.

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

See [prior evidence](docs/prior-evidence.md) for versions, metric definitions, resource observations, and public evidence links. HumanEval task correctness is not cross-backend numerical equivalence or long-context acceptance. **No experiment under the LLM Bootstrap protocol has been completed yet; platform SOTA and self-hosting remain unverified.**

## What counts as success?

Success is defined per experiment before tuning: quality and correctness gates, prefill/decode and client latency objectives, memory constraints, and a fixed compute/time budget. Report the gap to named, dated baselines alongside agent cost and human assistance.

A SOTA claim requires a credible search for strong current baselines, matched conditions or clearly separated comparison tracks, reproducible measurements, and stated workload boundaries. A result on one model and platform supports that configuration only. See the [protocol](docs/experiment-protocol.md) for the full reporting contract.

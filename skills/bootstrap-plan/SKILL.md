---
name: bootstrap-plan
description: Define a reproducible LLM Bootstrap experiment for an agent building a local inference engine, fixing hardware, target model, builder, harness, baselines, and measurable goals before implementation.
---

# Plan an inference bootstrap experiment

Read [the experiment protocol](../../docs/experiment-protocol.md). Use [the record template](../../experiments/TEMPLATE.md) and, when relevant, [the M5 Pro example](../../experiments/m5pro-qwen36-pi/example.json).

Resolve these bundled links relative to this SKILL.md file, not the current working directory. The plugin root is two directories above this file. Treat the installed plugin as read-only: create contracts, engine code, records, and evidence in the user's selected project workspace, never in the plugin installation/cache. Copy templates into that workspace before editing; the bundled example remains an unrun draft. Do not rely on the plugin repository's AGENTS.md being loaded by the host.

Use English for project writing, preserving literal inputs, identifiers, commands, hashes, and raw evidence. Use codex/ feature branches and pull requests for project changes; merge only with explicit user authorization. Do not publish weights, credentials, private prompts, or unreviewed agent transcripts; record hashes and access limitations instead. Keep planned targets, prior external evidence, and measurements from these skills distinct.

Turn the supplied platform and goal into a versioned experiment contract. Discover the actual machine and existing toolchain read-only; distinguish measured capabilities from assumptions. Identify the builder LLM separately from the target model and distinguish development from evaluation harnesses.

Resolve the model/weight/tokenizer and harness versions, permitted dependencies/code reuse, baseline selection, numerical and application checks, workload, timing definitions, quality/resource limits, experiment budget, and stopping rule. Define which metric “competitive” refers to and numerical criteria before tuning. Use dated primary sources to identify strong platform baselines; do not assume prior Infer.NET results establish current SOTA.

Mark missing essential fields as unresolved and obtain the information needed before dependent execution. Do not silently pick different hardware, precision, model, or thresholds. Publish a plan with a fixed skill revision and a concrete build/evaluation task. Keep preparation within the user's authorized scope; this skill does not itself authorize costly runs or operating-system changes.

Hand the frozen contract to bootstrap-build. Check a JSON contract's shape against the `ExperimentContract` schema in [the protocol schema](../../schema/experiment-protocol.openapi.yaml) when a validator is available; a frozen contract has no null fields. The schema checks structure only and does not replace the protocol. A plan is not a measured result.

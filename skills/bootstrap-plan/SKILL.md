---
name: bootstrap-plan
description: Define a reproducible LLM Bootstrap experiment for an agent building a local inference engine, fixing hardware, target model, builder, harness, baselines, and measurable goals before implementation.
---

# Plan an inference bootstrap experiment

Read [the experiment protocol](../../docs/experiment-protocol.md). Use [the record template](../../experiments/TEMPLATE.md) and, when relevant, [the M5 Pro example](../../experiments/m5pro-qwen36-pi/example.json).

Turn the supplied platform and goal into a versioned experiment contract. Discover the actual machine and existing toolchain read-only; distinguish measured capabilities from assumptions. Identify the builder LLM separately from the target model and distinguish development from evaluation harnesses.

Resolve the model/weight/tokenizer and harness versions, permitted dependencies/code reuse, baseline selection, numerical and application checks, workload, timing definitions, quality/resource limits, experiment budget, and stopping rule. Define which metric “competitive” refers to and numerical criteria before tuning. Use dated primary sources to identify strong platform baselines; do not assume prior Infer.NET results establish current SOTA.

Mark missing essential fields as unresolved and obtain the information needed before dependent execution. Do not silently pick different hardware, precision, model, or thresholds. Publish a plan with a fixed skill revision and a concrete build/evaluation task. Keep preparation within the user's authorized scope; this skill does not itself authorize costly runs or operating-system changes.

Hand the frozen contract to bootstrap-build. A plan is not a measured result.

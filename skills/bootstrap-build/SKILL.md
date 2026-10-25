---
name: bootstrap-build
description: Build and profile an inference engine specialized to a fixed LLM Bootstrap hardware/model contract, iterating from numerical correctness to measured optimizations and optional self-hosting.
---

# Build the engine

Read [the experiment protocol](../../docs/experiment-protocol.md) and the selected frozen experiment contract. If essential platform, model, budget, or acceptance fields are unresolved, use bootstrap-plan before dependent work.

Implement in a separate engine workspace/feature branch with the declared scaffold, languages, toolchain, and dependencies. Make platform-native implementation choices based on the contract. Baseline engines may supply independent references; using their inference backend must be disclosed and cannot stand in for an independently built backend when that is the research condition.

Get the minimal model execution path correct before optimizing: weight/tokenizer loading, tensor layouts, operators, attention/recurrent state, KV/reset behavior, and generation. Compare against the independent oracle at intermediate states and logits using the contract's tolerances. Expand representative input lengths before calling the engine validated. Keep application assertion checks separate from numerical equivalence.

Profile the actual runtime. Choose changes from measured bottlenecks, state the hypothesis, and retain the implementation revision and evidence for each attempt. Use a fixed small workload for iteration and the frozen formal workload for acceptance. Do not select only the fastest runs, silently fall back to another backend, or relax precision/caching/resource constraints to pass.

Record actual runtime builds and artifact hashes, commands, failures, budget consumption, and human help. Keep generated binaries, weights, private traces, and credentials out of project Git history. Stop at the declared budget or stopping condition, saving a useful partial result if acceptance is unmet.

If self-hosting is in scope and the builder model is supported, validate harness/tool behavior through the new engine, record the endpoint transition and runtime identity, and retain subsequent development evidence. Declare external recovery if used. A successful chat alone is not evidence of continued self-hosted development.

Hand candidate revisions and complete run instructions to bootstrap-evaluate; avoid performance or autonomy claims before that evaluation.

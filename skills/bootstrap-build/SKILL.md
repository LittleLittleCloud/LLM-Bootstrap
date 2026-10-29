---
name: bootstrap-build
description: Build and profile an inference engine specialized to a fixed LLM Bootstrap hardware/model contract, iterating from numerical correctness to measured optimizations and optional self-hosting.
---

# Build the engine

Read [the experiment protocol](../../docs/experiment-protocol.md) and the selected frozen experiment contract (for a derived contract, its resolved effective contract). If essential platform, model, budget, or acceptance fields are unresolved, use bootstrap-plan before dependent work.

Resolve bundled links relative to this SKILL.md file, not the current working directory. The plugin root is two directories above this file. Treat the installed plugin as read-only; read the contract and write engine code, records, and evidence in the user's selected project workspace, never in the plugin installation/cache. Do not rely on the plugin repository's AGENTS.md being loaded by the host.

Use English for project writing, preserving literal inputs, identifiers, commands, hashes, and raw evidence. Use codex/ feature branches and pull requests for project changes; merge only with explicit user authorization. Do not publish weights, credentials, private prompts, or unreviewed agent transcripts; record hashes and access limitations instead. Keep planned targets, prior external evidence, and measurements from these skills distinct.

Implement in a separate engine workspace/feature branch with the declared scaffold, languages, toolchain, and dependencies. Make platform-native implementation choices based on the contract. Baseline engines may supply independent references; using their inference backend must be disclosed and cannot stand in for an independently built backend when that is the research condition.

Get the minimal model execution path correct before optimizing: weight/tokenizer loading, tensor layouts, operators, attention/recurrent state, KV/reset behavior, and generation. Compare against the independent oracle at intermediate states and logits using the contract's tolerances. Expand representative input lengths before calling the engine validated. Keep application assertion checks separate from numerical equivalence.

Profile the actual runtime. Choose changes from measured bottlenecks, state the hypothesis, and retain the implementation revision and evidence for each attempt. Use a fixed small workload for iteration and the frozen formal workload for acceptance. Do not select only the fastest runs, silently fall back to another backend, or relax precision/caching/resource constraints to pass.

Record actual runtime builds and artifact hashes, commands, failures, budget consumption, and human help. Keep generated binaries, weights, private traces, and credentials out of project Git history. Stop at the declared budget or stopping condition, saving a useful partial result if acceptance is unmet.

If self-hosting is in scope and the builder model is supported, validate harness/tool behavior through the new engine, record the endpoint transition and runtime identity, and retain subsequent development evidence. Declare external recovery if used. A successful chat alone is not evidence of continued self-hosted development.

Hand candidate revisions and complete run instructions to bootstrap-evaluate; avoid performance or autonomy claims before that evaluation.

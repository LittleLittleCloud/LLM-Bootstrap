# Plan the experiment

Part of the [experiment SOP](../SKILL.md), whose rules on links, the read-only plugin, and publishing apply here. Resolve links relative to this file.

Read [the experiment protocol](experiment-protocol.md).

Turn the supplied platform and goal into a versioned `experiment.json`. Discover the actual machine and existing toolchain read-only; distinguish measured capabilities from assumptions. Identify the builder LLM separately from the target model and distinguish development from evaluation harnesses.

Resolve the model/weight/tokenizer and harness versions, permitted dependencies/code reuse, baseline selection, quality/resource limits, experiment budget, and stopping rule. Select the evaluation (workload, intelligence benchmarks, timing definitions) from the LLM Bootstrap repository's latest `main` commit, as described under Evaluations in [the SOP](../SKILL.md), and record that commit and the definition hash (see [the evaluation protocol](evaluation-protocol.md)). Never define or edit evaluation code, workload, or scoring inside an experiment, and do not use a draft evaluation for formal runs; if no released evaluation fits, stop and ask for one to be added to this repository. Define which metric “competitive” refers to and acceptance criteria before tuning. Use dated primary sources to identify strong platform baselines; do not assume prior Infer.NET results establish current SOTA.

Mark missing essential fields as unresolved and obtain the information needed before dependent execution. Do not silently pick different hardware, precision, model, or thresholds. Publish a plan with a fixed skill revision and a concrete build/evaluation task. Keep preparation within the user's authorized scope; this reference does not itself authorize costly runs or operating-system changes.

Hand the frozen experiment to [the build reference](build.md). To vary an existing experiment, write a derived `experiment.json` that extends a pinned base instead of copying it (see [the derived experiment steps](derived-experiment.md)); everything except the target model may be overridden, and the resolved effective experiment is what freezes. For a new experiment, see [the new experiment steps](new-experiment.md). Check the file's shape against the `Experiment` schema in [the protocol schema](../assets/schema/experiment-protocol.openapi.json) when a validator is available; a frozen experiment has no null fields. The schema checks structure only and does not replace the protocol. A plan is not a measured result.

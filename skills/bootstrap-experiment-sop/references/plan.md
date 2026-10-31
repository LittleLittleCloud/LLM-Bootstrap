# Plan the experiment

Part of the [experiment SOP](../SKILL.md), whose rules on links, the read-only plugin, and publishing apply here. Resolve links relative to this file.

Read [the experiment protocol](experiment-protocol.md).

Turn the supplied platform and goal into a versioned `experiment.json`. Discover the actual machine read-only and distinguish measured capabilities from assumptions. The file holds only what makes measurements comparable: the platform, the target model, the evaluation, the engine with its commit, the comparison track, and the goal thresholds. Anything else you learn about the machine or the engines goes in the results pull request description.

Select the evaluation (its tests and measurement definitions) from the LLM Bootstrap repository's latest `main` commit, as described under Evaluations in [the SOP](../SKILL.md), and record that commit and the definition hash (see [the evaluation protocol](evaluation-protocol.md)). Never define or edit evaluation code, workload, or scoring inside an experiment, and do not use a draft evaluation for formal runs; if no released evaluation fits, stop and ask for one to be added to this repository.

Define the goal thresholds before any evaluation. When a comparison is claimed, use dated primary sources to choose strong reference engines for the platform; do not assume prior Infer.NET results establish current SOTA.

Mark missing essential fields as unresolved and obtain the information needed before dependent execution. Do not silently pick a different platform, model, or threshold. Keep preparation within the user's authorized scope; this reference does not itself authorize costly runs or operating-system changes.

Hand the frozen experiment to [the evaluation reference](evaluate.md) once its engine is set up. To vary an existing experiment, write a derived `experiment.json` that extends a pinned base instead of copying it (see [Improve an experiment](mode-improve.md)); everything except the target model may be overridden, and the resolved effective experiment is what freezes. For a new experiment, see [Add an engine](mode-add-engine.md). Check the file's shape against the `Experiment` schema in [the protocol schema](../assets/schema/experiment-protocol.openapi.json) when a validator is available; a frozen experiment has no null fields. The schema checks structure only and does not replace the protocol. A plan is not a measured result.

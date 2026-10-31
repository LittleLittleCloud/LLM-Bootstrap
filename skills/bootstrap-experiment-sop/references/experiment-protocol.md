# Experiment protocol

## Research unit

An experiment is the metadata that makes engine measurements comparable: a platform, a target model, a repository-owned evaluation, the one engine measured with its commit, and goal thresholds. A report is one data point: that engine at that commit, measured by the evaluation on that platform. Experiments give a hill climb its shape. Each step is an experiment that derives from the one before it. Engines are compared across experiments that share a platform, a target model, and an evaluation.

How an engine was written is not part of the experiment and is not tracked. An LLM, a person, vibe coding, or a published project may have produced it; the project asks only what the engine measures. An engine may specialize to the platform and the target model.

An experiment is two kinds of JSON file. `experiment.json` holds the experiment's metadata, frozen before the first evaluation. Each file in `evaluation/` is the report of one evaluation run of the experiment's engine. Both are formalized in the OpenAPI schemas ([experiment](../assets/schema/experiment-protocol.openapi.json) and [evaluation](../assets/schema/evaluation-protocol.openapi.json)), which check shape and required declarations only. This prose protocol and the skills remain authoritative, and passing schema validation does not show correct measurements, followed procedure, or an experimental result.

## experiment.json

`experiment.json` is flat and minimal. Every field is a top-level key whose value is a scalar or an array of strings; there are no nested objects. A group of fields is a key prefix (`hardware_`, `target_`, `evaluation_`, `goal_`). A list of pairs is an array of `name=value` strings. An unresolved field is null while the status is `draft-not-run`, and a frozen experiment forbids null.

| Fields | Meaning |
| --- | --- |
| `experiment_id`, `status`, `description`, `contract_frozen_at` | Identity. `experiment_id` is the directory name. |
| `amends_revision`, `amends_reason` | Present only on an amendment. |
| `hardware_platform`, `hardware_gpu_cores`, `hardware_memory_gib` | The platform, so that two configurations of one chip stay distinct. |
| `target_repository`, `target_revision`, `target_weights` | The target model: repository, full commit, and quantization with weight precision. |
| `evaluation_id`, `evaluation_revision`, `evaluation_sha256` | The repository-defined evaluation, pinned by commit and definition hash (see the evaluation protocol). |
| `engine_name`, `engine_commit` | The one engine measured: a plain name without a path separator, and its full 40-character commit. How the engine was written is not recorded. |
| `comparison_track` | `matched-configuration` or `best-permitted-configuration`. |
| `goal_thresholds` | Acceptance thresholds, written `metric >= value` or `metric <= value` on a headline metric of the evaluation report, for example `decode_tokens_per_second_p50 >= 100` or `speed_ttft_ms_p50 <= 500`. A report that misses one is still recorded. |

Nothing else is a field. The operating system and toolchain, power mode, memory limit, KV and state precision, speculative decoding, memory and swap observed, how each engine was built and started with its artifact hashes, and any deviation from matched conditions (a CPU fallback, offloading, a different power mode) are stated in the results pull request description, where a reviewer can challenge them. Do not relax a condition silently to pass a threshold.

Freeze `experiment.json` in version control before the first evaluation. Because it names the engine's commit, the engine exists before its experiment is frozen. A submitted `experiment.json` is never edited, because the reports filed under it were judged against it. An amendment is a new experiment in its own directory that names the amended revision (`amends_revision`) and the reason (`amends_reason`); it does not retroactively redefine a result.

## Derived experiments

A new engine, a new commit of an engine, or a changed goal is a new experiment that derives from the experiment it improves. A derived `experiment.json` requires a base: it names it by `extends_path` (relative to the derived file), `extends_revision` (full commit), and `extends_sha256` (file hash), and lists overrides as top-level fields of the same names as the base fields. Without a base experiment there is nothing to derive from; use a new experiment. Everything may be overridden except the target model: a different target model is a different base experiment, never an override, so no `target_` field may appear.

To compare a new commit with the previous one, derive the new experiment from the experiment of the previous commit. It overrides `engine_commit` (or `engine_name`) and inherits the platform, the target model, and the evaluation, so the conditions match by construction.

Merging is deterministic and implemented by [scripts/resolve-experiment.mjs](../scripts/resolve-experiment.mjs). A field in the derived file replaces the base field of the same name. The derived file declares its own `experiment_id`, `status`, `description`, `contract_frozen_at`, and any amendment; these are never inherited.

The effective experiment (base plus overrides) is what freezes and runs. It must validate as a frozen `Experiment` with no unresolved fields before the first evaluation, which also rejects misspelled override fields. A base may itself be derived; every link is pinned by hash, so a chain cannot change silently. Reports are filed under the derived experiment. Results are not inherited from the base; a comparison with it is made between the reports of the two experiments.

## Evaluation

Evaluation is defined by the [evaluation protocol](evaluation-protocol.md), including measurement definitions and how to read a report. Evaluation code and scripts are owned by this repository, not by experiments or by whoever writes an engine. An experiment selects an evaluation by `evaluation_id`, `evaluation_revision`, and `evaluation_sha256`, and adds nothing else: the plan, the sizes, and the repetitions are the evaluation's.

## Comparing engines and SOTA

All experiments are treated alike. There is no gate on a report: a regression, a failed `conform` check, and a missing score are recorded and listed like any other result. The leaderboard shows the conformance result beside the metrics and does not filter by it, and the evaluation protocol says how to read a report whose `conform` failed.

To claim a comparison, select strong available engines using dated primary sources and measured support for the target platform and model, and measure each as its own experiment derived from one base, so that the platform, the target model, and the evaluation match. Record in the results pull request how they were chosen and which plausible ones could not be evaluated. Historical repository results are evidence pointers, not an up-to-date SOTA survey.

Use matched precision, workload, caching, speculation, and resource settings for attribution. An additional best-permitted-configuration track may compare complete systems with different optimizations, provided every difference is disclosed. Keep these tracks separate (`comparison_track`). Never present the ratio of incompatible native timing metrics as a controlled engine speedup.

A bounded SOTA claim names the device, model, workload, metric, comparison engines, date, and uncertainty. Without sufficient coverage, say "best among tested configurations" or "competitive with [named engine]". Claims and comparisons are made in the results pull request description, from the reports; they are not stored as fields.

## Experiment records

Everything an experiment produces lives under `experiments/<experiment-id>/`:

- `experiment.json`: the frozen experiment, or the derived experiment. Its `experiment_id` equals the directory name.
- `evaluation/<YYYYMMDD-HHMMSS>.json`: the report of one evaluation run, an `EvaluationReport`. The experiment gives the engine and its commit, so the path says what was measured. The name is the report's `started_at` in UTC. Every repeated, failed, or interrupted run is its own report.
- `evidence/`: local-only raw evidence, never committed, such as engine logs. The results pull request names it by hash and access limitation.

Only `experiment.json` and `evaluation/*.json` are committed to the repository. Results are submitted as a pull request, which the bootstrap-submit-results skill prepares. A report pins the evaluation (id, repository commit, definition hash) and must cite the same evaluation as the experiment. It does not pin the experiment: the file location does, and the pull request states how each endpoint was started and why it is the engine and commit recorded. A derived experiment's `extends_path` is relative to that file; other paths are relative to the repository root. `experiments/TEMPLATE.md` sits directly under `experiments/` and is not a record. Prior external evidence is not an experiment; it is kept in [prior-evidence.md](prior-evidence.md) so it is never mistaken for a result of these skills.

Interpretation, feedback, and claims are not part of the reports. They go in the results pull request description (see the bootstrap-submit-results skill): failures and their causes, recurring problems, suggested changes to skills or evaluations, calibration notes for goals, and limits on generalizing. It is reviewed text, never transcripts. A suggestion becomes a change only through a separate pull request to this repository. An evaluation is changed only by this repository, never from inside an experiment.

## Results and adoption

Keep implementation and results reviewable independently. Record failed, interrupted, neutral, and successful attempts: each is a report, and the tests that did not complete are listed in its `failures`. Preserve original observations when appending corrections; a correction is a new report, never an edit. A report identifies the evaluation pin, the model, the context window, the profile, and every measured request. The engine's identity, deviations from the experiment, and the environment are stated in the results pull request description.

Submit project changes through feature branches and PRs. Results publication and code adoption are separate decisions; neither implies experimental success. Merge requires explicit authorization. Do not publish private machine addresses, credentials, proprietary prompts, or model weights. Local-only evidence is explicitly marked, never disguised as a public download. A report records an endpoint only by class, never by address, and holds no token.

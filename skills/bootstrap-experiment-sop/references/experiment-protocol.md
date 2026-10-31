# Experiment protocol

## Research unit

An experiment fixes hardware, target model, builder LLM, agent harness, workload, resource budget, allowed dependencies, and acceptance criteria. An engine may specialize to that configuration. Record the skill repository commit and hashes of the exact instructions provided to the builder; a later skill revision defines a new treatment.

The builder LLM writes the engine. The target model runs inside it. Their identities may differ, but self-hosting requires the builder's inference to actually move onto the generated engine. Record where initial builder inference runs and who controls routing. Improving an engine while continuing to use an unrelated hosted builder is engine construction, not demonstrated self-hosting.

An experiment is two kinds of JSON file. `experiment.json` holds the experiment's metadata: everything frozen before tuning. Each file in `evaluation/<subject>/` is the report of one evaluation run of one engine. Both are formalized in the OpenAPI schemas ([experiment](../assets/schema/experiment-protocol.openapi.json) and [evaluation](../assets/schema/evaluation-protocol.openapi.json)), which check shape and required declarations only. This prose protocol and the skills remain authoritative, and passing schema validation does not show correct measurements, followed procedure, or an experimental result.

`experiment.json` is flat. Every field is a top-level key whose value is a scalar or an array of strings; there are no nested objects. A group of fields is a key prefix (`hardware_`, `target_`, `goal_`, `setting.`, and so on). A list of pairs is an array of `name=value` strings. A declaration that a field does not apply, or that a detail is unavailable, is a string that starts with `Not applicable: ` or `Unavailable: ` and gives the reason. Every unresolved experimental field must be resolved or explicitly declared inapplicable before execution; a frozen experiment forbids unresolved (null) fields. A report is a nested document of measurements defined by the evaluation protocol, so it needs none of these declarations. Keep the development harness separate from the evaluation, which runs in a browser against an endpoint.

## Freeze before tuning

Record in `experiment.json`:

- Experiment ID (the directory name), description, scope, baseline engine revisions, starting engine/scaffold revision, code reuse, and allowed implementation dependencies. State whether baseline source inspection is allowed. Wrapping a baseline engine does not demonstrate building an inference backend.
- Hardware model, GPU/core configuration, physical memory/VRAM, OS, drivers, compiler/runtime, power mode, and relevant memory limits. Record exclusive GPU use. Any CPU fallback, offloading, SSD streaming, or multi-host participation is a deviation, stated in the results pull request description.
- Target repository/revision, weight and tokenizer hashes, chat template, quantization method/group size, weight/activation/KV/recurrent-state precision, and speculative draft identities/settings.
- Builder model/provider/revision or provider-exposed identifier, inference location, decoding settings, network/source access, development harness name/version/revision. Mark provider details that are unavailable; do not fabricate immutable IDs. The starting context is the hashed builder instructions.
- The repository-defined evaluation (id, repository revision, and definition hash; see the evaluation protocol).
- Primary performance metric, the acceptance thresholds, permitted quality loss, memory/swap constraints, allowed optimizations, total wall-clock/token/compute budgets, and stopping rules. Thresholds are written `metric >= value` or `metric <= value` on a headline metric of the evaluation report (for example `decode_tokens_per_second_p50 >= 100` or `speed_ttft_ms_p50 <= 500`). The evaluation cannot measure memory or swap, so resource limits that matter are stated in the scope or the stopping rule and checked by the person running the engine. Explicitly state which operating-system changes are in scope; no silent precision or resource-limit relaxation.

Freeze `experiment.json` in version control before implementation. A submitted `experiment.json` is never edited, because the reports filed under it were judged against it. An amendment is a new experiment in its own directory that names the amended revision (`amends_revision`) and the reason (`amends_reason`); it does not retroactively redefine a successful run. Existing user authorization governs execution. Missing essential configuration is resolved before dependent work, while independent preparation may continue.

## Derived experiments

An experiment may derive from a base experiment instead of restating it. A derived `experiment.json` names its base by `extends_path` (relative to the derived file), `extends_revision` (full commit), and `extends_sha256` (file hash), and lists overrides as top-level fields of the same names as the base fields. Everything may be overridden except the target model: a different target model is a different base experiment, never an override, so no `target_` field may appear.

Merging is deterministic and implemented by [scripts/resolve-experiment.mjs](../scripts/resolve-experiment.mjs). A field in the derived file replaces the base field of the same name. The derived file declares its own `experiment_id`, `status`, `description`, `contract_frozen_at`, and any amendment; these are never inherited. The skill revision and builder instruction hashes are inherited unless overridden, and overriding them changes the treatment.

The effective experiment (base plus overrides) is what freezes and runs. It must validate as a frozen `Experiment` with no unresolved fields before tuning, which also rejects misspelled override fields. A base may itself be derived; every link is pinned by hash, so a chain cannot change silently. Reports are filed under the derived experiment. Results are not inherited from the base, so any comparison with it needs its own matched evaluations.

## Evaluation

Evaluation is defined by the [evaluation protocol](evaluation-protocol.md), including correctness gates and measurement definitions. Evaluation code and scripts are owned by this repository, not by experiments or the builder LLM. An experiment selects an evaluation by `evaluation_id`, `evaluation_revision`, and `evaluation_sha256`, and adds nothing else: the plan, the sizes, and the repetitions are the evaluation's.

## Baselines and SOTA

Select strong available engines using dated primary sources and measured support for the target hardware/model. Record how the candidate set was chosen and which plausible alternatives could not be evaluated. Historical repository results are evidence pointers, not an up-to-date SOTA survey.

Use matched precision, workload, caching, speculation, and resource settings for attribution. An additional best-permitted-configuration track may compare complete systems with different optimizations, provided the quality/resource envelope is fixed and every difference is disclosed. Keep these tracks separate (`baseline_comparison_track`). Never present the ratio of incompatible native timing metrics as a controlled engine speedup.

A bounded SOTA claim names the device, model, workload, metric, quality/resource envelope, comparison engines, date, and uncertainty. Without sufficient baseline coverage, say “best among tested configurations” or “competitive with [named baseline]”. Retest adoption against a changed baseline when relevant. Claims and comparisons are made in the results pull request description, from the reports of the baselines and the candidate; they are not stored as fields.

## Autonomy and self-hosting

Record all human interventions with timestamps and purpose: task setup, implementation hints, debugging, code edits, environment repair, and approval. Retain builder/tool traces privately as needed, publishing redacted evidence and hashes. Track builder tokens, API cost when available, elapsed time, experiments attempted, and hardware hours. Unavailable historical autonomy data remains unknown.

A report holds none of this, because the evaluator is told nothing about the engine or its history. The totals so far (`human_interventions`, `builder_tokens`, `elapsed_hours`, `hardware_hours`, each a number or `Unavailable: reason`) are stated in the results pull request description, and the itemized intervention log stays in local evidence, referenced by hash.

For self-hosting, record the exact transition point, builder/target identity match, generated engine runtime/artifact identity, actual harness endpoint routing, and subsequent development steps executed through that engine, and state them in the results pull request description with the hash of the local evidence. The experiment's `goal_self_hosting_in_scope` says whether it is in scope. Distinguish an external recovery path from uninterrupted self-hosting. A claim of recursive improvement also requires a measured subsequent engine revision, with correctness retained, which is a later report. No field of a report or of the leaderboard says that self-hosting was demonstrated: the claim is reviewed text.

## Experiment records

Everything an experiment produces lives under `experiments/<experiment-id>/`:

- `experiment.json`: the frozen experiment (or the derived experiment). Its `experiment_id` equals the directory name.
- `evaluation/<subject>/<YYYYMMDD-HHMMSS>.json`: the report of one evaluation run, an `EvaluationReport`. The subject is `candidate` or the name of one of the experiment's `baseline_engines`, so the directory says what was measured; the experiment says everything else. The name is the report's `started_at` in UTC. A baseline and a candidate are separate reports, and so is every repeated, failed, or interrupted run.
- `evidence/`: local-only raw evidence, never committed, such as engine logs and the itemized intervention log. The results pull request names it by hash and access limitation.

Only `experiment.json` and `evaluation/<subject>/*.json` are committed to the repository. Results are submitted as a pull request, which the bootstrap-submit-results skill prepares. A report pins the evaluation (id, repository commit, definition hash) and must cite the same evaluation as the experiment. It does not pin the experiment: the file location does, and the pull request states how the endpoint was started and why it is the engine of the subject. A derived experiment's `extends_path` is relative to that file; other paths are relative to the repository root. `experiments/TEMPLATE.md` sits directly under `experiments/` and is not a record. Prior external evidence is not an experiment; it is kept in [prior-evidence.md](prior-evidence.md) so it is never mistaken for a result of these skills.

Interpretation, feedback, and claims are not part of the reports. They go in the results pull request description (see the bootstrap-submit-results skill): failures and their causes, the preflight checks that would have caught them, recurring human interventions, suggested changes to skills or evaluations, calibration notes for baselines, budgets, and thresholds, and limits on generalizing. It is reviewed text, never transcripts. A suggestion becomes a change only through a separate pull request to this repository. A changed skill revision is a new treatment, and an evaluation is changed only by this repository, never from inside an experiment.

## Results and adoption

Keep implementation and results reviewable independently. Record failed, interrupted, neutral, and successful attempts: each is a report, and the tests that did not complete are listed in its `failures`. Preserve original observations when appending corrections; a correction is a new report, never an edit. A report identifies the evaluation pin, the model, the context window, the profile, and every measured request. The deviations from the experiment, the engine's identity, and the environment are stated in the results pull request description, where a reviewer can challenge them.

Submit project changes through feature branches and PRs. Results publication and code adoption are separate decisions; neither implies experimental success. Merge requires explicit authorization. Do not publish private machine addresses, credentials, proprietary prompts, or model weights. Local-only evidence is explicitly marked, never disguised as a public download. A report records an endpoint only by class, never by address, and holds no token.

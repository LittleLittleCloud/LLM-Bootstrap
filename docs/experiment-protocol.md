# Experiment protocol

## Research unit

An experiment fixes hardware, target model, builder LLM, agent harness, workload, resource budget, allowed dependencies, and acceptance criteria. An engine may specialize to that configuration. Record the skill repository commit and hashes of the exact instructions provided to the builder; a later skill revision defines a new treatment.

The builder LLM writes the engine. The target model runs inside it. Their identities may differ, but self-hosting requires the builder's inference to actually move onto the generated engine. Record where initial builder inference runs and who controls routing. Improving an engine while continuing to use an unrelated hosted builder is engine construction, not demonstrated self-hosting.

The example JSON is a planning aid. Its structure, and that of run records, is formalized in the [OpenAPI schema](../schema/experiment-protocol.openapi.json), which checks shape and required declarations only. It models just the core fields; per-request records and other raw detail stay in hashed evidence files. This prose protocol and the skills remain authoritative, and passing schema validation does not show correct measurements, followed procedure, or an experimental result. Every unresolved experimental field must be resolved or explicitly declared inapplicable before execution; a frozen contract forbids unresolved (null) fields. Keep separate identities for the development harness and the evaluation harness.

## Freeze before tuning

Record:

- Experiment ID, goal, scope, baseline engine revisions, starting engine/scaffold revision, code reuse, and allowed implementation dependencies. State whether baseline source inspection is allowed. Wrapping a baseline engine does not demonstrate building an inference backend.
- Hardware model, GPU/core configuration, physical memory/VRAM, OS, drivers, compiler/runtime, power mode, thermal observations, and relevant memory limits. Record exclusive GPU use and any CPU fallback, offloading, SSD streaming, or multi-host participation.
- Target repository/revision, weight and tokenizer hashes, chat template, quantization method/group size, weight/activation/KV/recurrent-state precision, context limit, sampling settings, and speculative draft identities/settings.
- Builder model/provider/revision or provider-exposed identifier, inference location, decoding settings, tools, network/source access, harness version/revision, and starting context. Mark provider details that are unavailable; do not fabricate immutable IDs.
- The repository-defined evaluation (id, repository revision, and definition hash; see the evaluation protocol), warm-up, formal repetitions, and correctness oracle/tolerances.
- Primary performance metric and numerical acceptance thresholds, permitted quality loss, memory/swap constraints, allowed optimizations, total wall-clock/token/compute budgets, and stopping rules. Explicitly state which operating-system changes are in scope; no silent precision or resource-limit relaxation.

Freeze the contract in version control before implementation. Amendments receive a new revision and a reason; they do not retroactively redefine a successful run. Existing user authorization governs execution. Missing essential configuration is resolved before dependent work, while independent preparation may continue.

## Derived experiments

An experiment may derive from a base experiment instead of restating it. A derived contract (`DerivedExperimentContract` in the [schema](../schema/experiment-protocol.openapi.json)) names its base by path, full commit, and file hash, and lists overrides. Everything may be overridden except the target model: a different target model is a different base experiment, never an override.

Merging is deterministic and implemented by [schema/resolve-contract.mjs](../schema/resolve-contract.mjs). Objects merge by key, while arrays, scalars, and null replace the base value. The derived contract declares its own `experiment_id`, `status`, `description`, freeze time, and any amendment; these are never inherited. The skill revision and builder instruction hashes are inherited unless overridden, and overriding them changes the treatment.

The effective contract (base plus overrides) is what freezes and runs. It must validate as a frozen contract with no unresolved fields before tuning, which also rejects misspelled override keys. A base may itself be derived; every link is pinned by hash, so a chain cannot change silently. Runs cite the derived contract file. Results are not inherited from the base, so any comparison with it needs its own matched runs.

## Evaluation

Evaluation is defined by the [evaluation protocol](evaluation-protocol.md), including correctness gates and measurement definitions. Evaluation code and scripts are owned by this repository, not by experiments or the builder LLM. A contract selects an evaluation by id, repository revision, and definition hash, and adds only what depends on the experiment: warm-up, formal repetitions, and the numerical oracle and tolerances.

## Baselines and SOTA

Select strong available engines using dated primary sources and measured support for the target hardware/model. Record how the candidate set was chosen and which plausible alternatives could not be evaluated. Historical repository results are evidence pointers, not an up-to-date SOTA survey.

Use matched precision, workload, caching, speculation, and resource settings for attribution. An additional best-permitted-configuration track may compare complete systems with different optimizations, provided the quality/resource envelope is fixed and every difference is disclosed. Keep these tracks separate. Never present the ratio of incompatible native timing metrics as a controlled engine speedup.

A bounded SOTA claim names the device, model, workload, metric, quality/resource envelope, comparison engines, date, and uncertainty. Without sufficient baseline coverage, say “best among tested configurations” or “competitive with [named baseline]”. Retest adoption against a changed baseline when relevant.

## Autonomy and self-hosting

Record all human interventions with timestamps and purpose: task setup, implementation hints, debugging, code edits, environment repair, and approval. Retain builder/tool traces privately as needed, publishing redacted evidence and hashes. Track builder tokens, API cost when available, elapsed time, experiments attempted, and hardware hours. Unavailable historical autonomy data remains unknown.

For self-hosting, record the exact transition point, builder/target identity match, generated engine runtime/artifact identity, actual harness endpoint routing, and subsequent development steps executed through that engine. Distinguish an external recovery path from uninterrupted self-hosting. A claim of recursive improvement also requires a measured subsequent engine revision, with correctness retained.

## Experiment records

Everything an experiment produces lives under `experiments/<experiment-id>/`:

- `contract.json`: the frozen contract, or the derived contract.
- `record.md`: the human-readable record, a copy of [the template](../experiments/TEMPLATE.md).
- `runs/<run-id>/run.json`: one `ExperimentRun`, with the evaluation result documents it references beside it (for example `candidate-<engine>.json`).
- `evidence/`: local-only raw evidence, never committed. Run records refer to it by hash and access limitation.

Paths inside these documents are relative to the repository root, except a derived contract's `extends.path`, which is relative to that contract file. `experiments/TEMPLATE.md` and the unrun example sit directly under `experiments/` and are not records. Prior external evidence is not an experiment; it is kept in [prior-evidence.md](prior-evidence.md) so it is never mistaken for a result of these skills.

## Results and adoption

Keep implementation and results reviewable independently. Record failed, interrupted, neutral, and successful attempts; preserve original observations when appending corrections. Each run identifies the contract revision, skills revision, implementation/runtime SHA and artifact hashes, configuration, commands, raw evidence hashes/access, quality results, resource gates, metric coverage, and interpretation.

Submit project changes through feature branches and PRs. Results publication and code adoption are separate decisions; neither implies experimental success. Merge requires explicit authorization. Do not publish private machine addresses, credentials, proprietary prompts, or model weights. Local-only evidence is explicitly marked, never disguised as a public download.

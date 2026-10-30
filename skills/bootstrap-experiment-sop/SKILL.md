---
name: bootstrap-experiment-sop
description: Run an LLM Bootstrap experiment end to end, either a new experiment or an improvement derived from an existing one. Plans and freezes the contract, builds a specialized inference engine, evaluates it against the pinned evaluation, and reports with feedback, using explicit stage gates and a contract check command.
---

# Experiment SOP

Read [the experiment protocol](references/experiment-protocol.md) and [the evaluation protocol](references/evaluation-protocol.md). This skill sequences the experiment and enforces the gates between stages. The stage work is in [the planning reference](references/plan.md), [the build reference](references/build.md), and [the evaluation reference](references/evaluate.md); do not relax their rules here.

Resolve bundled links relative to this SKILL.md file, not the current working directory. The skill root is the directory that holds this file, and everything the skill needs is inside it except the evaluations (see Evaluations below). Treat the installed plugin as read-only: create contracts, engine code, records, and evidence in the user's selected project workspace, never in the plugin installation/cache. Do not rely on the plugin repository's AGENTS.md being loaded by the host.

Use English for project writing, preserving literal inputs, identifiers, commands, hashes, and raw evidence. Use codex/ feature branches and pull requests for project changes; merge only with explicit user authorization. Do not publish weights, credentials, private prompts, or unreviewed agent transcripts; record hashes and access limitations instead. Keep planned targets, prior external evidence, and measurements from these skills distinct.

A revision always means a full 40-character Git commit SHA, never a branch or tag name. It applies to the skill repository, the evaluation, baseline engines, and the engine under test.

## Choose the mode

Ask the user which mode applies before doing anything else.

- **New experiment:** a new hardware, target model, or goal. Follow [the new experiment steps](references/new-experiment.md).
- **Derived experiment:** an improvement of an existing experiment that keeps its target model and changes other things. Follow [the derived experiment steps](references/derived-experiment.md). If the user wants a different target model, that is a new experiment, not a derived one.

## Stages and gates

Each gate must hold before the next stage starts. If it does not, stop and say which condition is missing; do not substitute your own value for a missing one.

| Stage | Work | Gate to leave the stage |
| --- | --- | --- |
| 1. Define | Mode-specific steps; [the planning reference](references/plan.md) for contract content. | The check command reports no problems, the status is `frozen`, and no field is unresolved. |
| 2. Freeze | Commit the contract on a codex/ branch and record its commit. | The contract commit exists before any engine work. Amendments are new revisions with a reason. |
| 3. Build | [The build reference](references/build.md), in a separate engine workspace. | The engine loads the target model and serves the endpoint the evaluation will call. |
| 4. Evaluate | [The evaluation reference](references/evaluate.md) with the pinned evaluation. | The negative control of the evaluation is verified before any result is reported. |
| 5. Report | Fill the report, including its feedback section, and a run record. | Every acceptance criterion is marked passed, failed, or open, and the feedback section is filled in. |
| 6. Submit | Use bootstrap-submit-results to open a results PR against the LLM Bootstrap repository, separate from any implementation change. | The user authorized the PR; the PR is open. Merging is the maintainers' decision. |

Keep implementation and results in separate changes. Publishing results does not imply acceptance and does not authorize a merge. Costly runs and operating-system changes need the user's authorization even when the contract names them in scope.

## Workspace layout

In the user's project workspace, keep one directory per experiment: `experiments/<experiment-id>/` with `contract.json`, `report.md` (a copy of [the report template](assets/report-template.md)), `runs/<run-id>/run.json` with the evaluation result documents it references beside it, and `evidence/` for local-only raw evidence that is never committed. The layout is defined in [the experiment protocol](references/experiment-protocol.md), so records can be submitted unchanged. Write the contract against `ExperimentContract` in [the protocol schema](assets/schema/experiment-protocol.openapi.json); unresolved fields stay null until it is frozen.

## Evaluations

Evaluations are not bundled with this skill. They are defined only by the LLM Bootstrap repository, `https://github.com/LittleLittleCloud/LLM-Bootstrap`, under `evaluations/<evaluation-id>/`. Take them from the latest commit of its `main` branch:

1. Resolve that commit when planning: `git ls-remote https://github.com/LittleLittleCloud/LLM-Bootstrap.git refs/heads/main`.
2. Read the definitions and scripts at exactly that commit, for example in a scratch clone checked out at it, outside the project workspace and outside any installed plugin. Choose a `released` definition.
3. Record that full commit as the contract's evaluation `revision` and the definition file's sha256. Later stages use the recorded revision, never a newer `main`.

Do not use an evaluation copy that shipped with an installed plugin, was cached earlier, or has local changes. See [the evaluation protocol](references/evaluation-protocol.md).

## Check a contract

Run the skill's check script. It needs Node.js 22 or newer and no packages:

```sh
node <skill-root>/scripts/check-experiment.mjs experiments/<experiment-id>/contract.json
```

It follows `extends` links and verifies each base against its pinned hash, lists exactly which fields a derived contract changes, reports unresolved (null) fields, and fails a frozen contract that has any. When Ajv can be resolved (it is a dev dependency of the plugin repository, so it is absent from an installed copy) it also validates the result against `ExperimentContract` in [the protocol schema](assets/schema/experiment-protocol.openapi.json); otherwise it says the schema was not checked, and you must say so rather than call the contract valid. A clean check shows structure only; it does not show that the plan is sound or that anything was measured.

## Record the treatment

Before freezing, record the skill repository's full commit and the hashes of the exact instructions given to the builder. Read the commit from the installed plugin when it is discoverable; otherwise ask the user. A later skill revision is a different treatment.

---
name: bootstrap-experiment-sop
description: Run an LLM Bootstrap experiment in one of three modes. Add an engine on a new platform and target model, evaluate the engine of an existing experiment with the Evaluate page, or improve an existing experiment by deriving a new one from it. Uses explicit stage gates, the pinned repository evaluation, and an experiment check command.
---

# Experiment SOP

Read [the experiment protocol](references/experiment-protocol.md) and [the evaluation protocol](references/evaluation-protocol.md). This skill sequences the experiment and enforces the gates between stages. The stage work is in [the planning reference](references/plan.md), [the build reference](references/build.md), and [the evaluation reference](references/evaluate.md); do not relax their rules here.

Resolve bundled links relative to this SKILL.md file, not the current working directory. The skill root is the directory that holds this file, and everything the skill needs is inside it except the evaluations (see Evaluations below). Treat the installed plugin as read-only: create experiments, engine code, records, and evidence in the user's selected project workspace, never in the plugin installation/cache. Do not rely on the plugin repository's AGENTS.md being loaded by the host.

Use English for project writing, preserving literal inputs, identifiers, commands, hashes, and raw evidence. Use codex/ feature branches and pull requests for project changes; merge only with explicit user authorization. Do not publish weights, credentials, private prompts, or unreviewed agent transcripts; record hashes and access limitations instead. Keep planned targets, prior external evidence, and measurements from these skills distinct.

A revision always means a full 40-character Git commit SHA, never a branch or tag name. It applies to the evaluation, the target model, and every engine.

## Choose the mode

There are three modes. They differ in what you start from and what you produce; every mode ends with the same evaluation, report, and submit stages. An engine can come from anywhere (an LLM, a person, vibe coding, a published project): the experiment records its name and commit, not how it was written.

| Mode | Use it to | Starts from | Produces | Steps |
| --- | --- | --- | --- | --- |
| **Add an engine** | Start on a new platform, target model, or goal, with the engine to measure there. | Hardware, target model, goal, and an engine at a commit | A new `experiment.json` and its reports | [Add an engine](references/mode-add-engine.md) |
| **Evaluate** | Measure the engine an existing experiment already names, at the commit it records, with the Evaluate page. Nothing in the experiment changes. | A frozen experiment and a running endpoint | Reports only | [Evaluate](references/mode-evaluate.md) |
| **Improve** | Take the next step of a hill climb: a new engine commit, an added engine, or a changed goal, keeping the target model. | A frozen **base experiment** with reports | A derived `experiment.json` and its reports | [Improve an experiment](references/mode-improve.md) |

Pick the mode by asking, in this order, and stop at the first yes:

1. Does a frozen experiment already name the engine at the commit to measure, and does nothing in its contract need to change? Then **Evaluate**.
2. Is there an existing experiment with the right target model, even if the engine, its commit, or a goal differs? Then **Improve**. It requires that base experiment, pinned by path, commit, and hash. Without one, go to 3.
3. Otherwise (new hardware, a different target model, a new goal, or no experiment to build on), **Add an engine**.

Ask the user which mode applies, proposing the one these questions give, before doing anything else. Requests such as "add an engine" or "start a new experiment" mean Add an engine, "improve experiment `<id>`" or "derive an experiment from `<id>`" means Improve, and "run the evaluation on my endpoint" means Evaluate. If the answer to question 1 is "almost", the difference is a contract change, so it is Improve.

## Stages and gates

Which stages a mode runs:

| Stage | Add an engine | Evaluate | Improve |
| --- | --- | --- | --- |
| 1. Define | write a new experiment | select an existing experiment | derive from the base |
| 2. Freeze | run | skip, already frozen | run |
| 3. Prepare the engine | build it or set it up | set it up at the recorded commit | build it or set it up |
| 4. Evaluate | run | run | run |
| 5. Report | run | run | run |
| 6. Submit | run | run | run |

Each gate must hold before the next stage starts. If it does not, stop and say which condition is missing; do not substitute your own value for a missing one.

| Stage | Work | Gate to leave the stage |
| --- | --- | --- |
| 1. Define | The mode's steps; [the planning reference](references/plan.md) for experiment content. | The check command reports no problems, the status is `frozen`, and no field is unresolved. In Evaluate mode, the experiment is fetched unchanged at a recorded commit and the engine is its `engine_name` at its `engine_commit`. |
| 2. Freeze | Commit `experiment.json` on a codex/ branch and record its commit. | The commit exists before the first evaluation. An amendment is a new experiment with a reason. |
| 3. Prepare the engine | Optionally [the build reference](references/build.md), in a separate engine workspace; otherwise set up the existing engine at its commit. | The engine, at exactly the commit the experiment records, loads the target model and serves the endpoint the evaluation will call. |
| 4. Evaluate | [The evaluation reference](references/evaluate.md) with the pinned evaluation. | Every selected test is complete, or its failures are listed. No report is edited. |
| 5. Report | Check each evaluation report, then write the interpretation and feedback for the results PR description. | Every goal threshold is marked met, missed, or open, and the feedback is written. |
| 6. Submit | Use bootstrap-submit-results to open a results PR against the LLM Bootstrap repository, separate from any implementation change. | The user authorized the PR; the PR is open. Merging is the maintainers' decision. |

Keep implementation and results in separate changes. Publishing results does not imply acceptance and does not authorize a merge. Costly runs and operating-system changes need the user's authorization.

## Workspace layout

In the user's project workspace, keep one directory per experiment, `experiments/<experiment-id>/`, with `experiment.json` (the experiment's metadata, frozen before tuning), `evaluation/<YYYYMMDD-HHMMSS>.json` (one report per evaluation run, exported by the evaluator page and named after its UTC start time), and `evidence/` for local-only raw evidence that is never committed. In Evaluate mode, `experiment.json` is fetched unchanged from the repository and only new reports are added. Only `experiment.json` and `evaluation/*.json` are submitted. `experiment.json` is flat JSON: top-level scalars and arrays of strings, no nested objects. A report is the evaluator's own document. The layout is defined in [the experiment protocol](references/experiment-protocol.md), so reports can be submitted unchanged. Write `experiment.json` against `Experiment` in [the protocol schema](assets/schema/experiment-protocol.openapi.json); unresolved fields stay null until it is frozen.

## Evaluations

Evaluations are not bundled with this skill. They are defined only by the LLM Bootstrap repository, `https://github.com/LittleLittleCloud/LLM-Bootstrap`, under `evaluations/<evaluation-id>/`. Take them from the latest commit of its `main` branch:

1. Resolve that commit when planning: `git ls-remote https://github.com/LittleLittleCloud/LLM-Bootstrap.git refs/heads/main`.
2. Read the definitions and scripts at exactly that commit, for example in a scratch clone checked out at it, outside the project workspace and outside any installed plugin. Choose a `released` definition.
3. Record that full commit as the experiment's `evaluation_revision` and the definition file's sha256 as `evaluation_sha256`. Later stages use the recorded revision, never a newer `main`.

Do not use an evaluation copy that shipped with an installed plugin, was cached earlier, or has local changes. See [the evaluation protocol](references/evaluation-protocol.md).

## Check an experiment

Run the skill's check script. It needs Node.js 22 or newer and no packages:

```sh
node <skill-root>/scripts/check-experiment.mjs experiments/<experiment-id>/experiment.json
```

It follows `extends_path` links and verifies each base against its pinned hash, lists exactly which fields a derived experiment changes, reports unresolved (null) fields, and fails a frozen experiment that has any. When Ajv can be resolved (it is a dev dependency of the plugin repository, so it is absent from an installed copy) it also validates the result against `Experiment` in [the protocol schema](assets/schema/experiment-protocol.openapi.json); otherwise it says the schema was not checked, and you must say so rather than call the experiment valid. A clean check shows structure only; it does not show that the plan is sound or that anything was measured.

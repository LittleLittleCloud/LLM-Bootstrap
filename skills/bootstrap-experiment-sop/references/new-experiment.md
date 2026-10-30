# New experiment

Stage 1 and 2 of the [experiment SOP](../SKILL.md) for an experiment with no base. Resolve links relative to this file.

1. **Intake.** Collect the goal, hardware, target model, builder LLM, budget, and what the user authorizes. Discover the machine read-only and separate measured capabilities from assumptions. Mark anything missing as unresolved and ask; do not pick hardware, precision, model, or thresholds on the user's behalf.
2. **Select the evaluation.** Choose a `released` evaluation as described under Evaluations in [the SOP](../SKILL.md): resolve the latest `main` commit of the LLM Bootstrap repository, read the definitions at that commit, and record the commit and the definition hash (see [the evaluation protocol](evaluation-protocol.md)). If none fits or the only candidate is a draft, stop and ask for one to be added to this repository. Never define a workload or scoring inside the experiment.
3. **Choose baselines.** Use dated primary sources. Record how candidates were chosen and which plausible ones could not be run. Prior Infer.NET results are evidence pointers, not a current SOTA survey.
4. **Define success first.** Fix the primary metric, quality and resource gates, stopping rule, and budget before any tuning.
5. **Write the experiment.** Write `experiments/<experiment-id>/experiment.json` against `Experiment` in [the protocol schema](../assets/schema/experiment-protocol.openapi.json): every field is required and flat (no nested objects), and an unresolved field is null while the status is `draft-not-run`. Follow [the planning reference](plan.md) to resolve every field, or declare it not applicable with a reason (`Not applicable: reason`). Set `status` to `frozen` only when nothing is unresolved.
6. **Check it.** Run the check command from [the SOP](../SKILL.md). Fix every problem it reports; do not edit the schema or the check to make an experiment pass.
7. **Baseline preflight.** Run the pinned evaluation once against a baseline engine to confirm that the evaluation, hardware, and measurement path work, so a broken setup is found before the freeze rather than after the build.
8. **Freeze.** Commit `experiment.json` on a codex/ branch, keep the commit for the evaluation records, and hand off to [the build reference](build.md).

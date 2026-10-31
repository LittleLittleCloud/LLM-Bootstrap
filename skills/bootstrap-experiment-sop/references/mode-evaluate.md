# Mode: Evaluate

Stage 1 of the [experiment SOP](../SKILL.md) for measuring the engine of an experiment that already exists. Resolve links relative to this file. Nothing in the experiment changes: this mode adds reports and no `experiment.json`, so there is no freeze.

Use it only when a frozen experiment already names the engine at the commit you will serve. If the commit, an added engine, or a goal must change, use [Improve an experiment](mode-improve.md). If the platform or the target model is new, use [Add an engine](mode-add-engine.md).

1. **Select the experiment.** Ask which experiment, by id. Fetch `experiments/<experiment-id>/experiment.json` unchanged at a recorded full commit of the LLM Bootstrap repository, or use the user's own already frozen experiment and its freeze commit. For a derived experiment, fetch every base along `extends_path` at its pinned hash. It must be `frozen`.
2. **Check it.** Run the check command from [the SOP](../SKILL.md). Fix nothing in the experiment: if the check fails, report the failure and stop.
3. **Serve the engine.** It is the experiment's `engine_name` at its `engine_commit`; serve that commit, not a later one. A different commit or another engine is not measured here: derive a new experiment with [Improve an experiment](mode-improve.md).
4. **Match the conditions.** Compare the machine and the engine's settings with the experiment's platform and target model. Record every difference as a deviation to state in the pull request; a report measured on other hardware or another model is not a measurement of this experiment.
5. **Hand off to the evaluation.** Go to [the evaluation reference](evaluate.md), which uses the experiment's pinned evaluation revision and never a newer `main`. Run the `full` profile for a result. Repeat measurements when variability matters, and keep every failed, interrupted, or neutral run.
6. **Report and submit.** Check each report as the evaluation reference says, write the interpretation, and use bootstrap-submit-results. When the experiment is already in the repository, the pull request adds reports only and does not touch `experiment.json`.

Reports taken under someone else's experiment are replications, and the description says so.

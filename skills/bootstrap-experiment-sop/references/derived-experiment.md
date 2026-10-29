# Derived experiment

Stage 1 and 2 of the [experiment SOP](../SKILL.md) for an improvement of an existing experiment. Resolve links relative to this file. The rules for derived contracts are in [the experiment protocol](experiment-protocol.md).

1. **Pin the base.** Record the base contract's path, full commit, and file hash. The base must be a frozen contract. Read its run record and results first: if it has none, say that the derived experiment has no evidence to improve on.
2. **Find the gap.** State which result or failure in the base motivates the change, and quote the base evidence for it. The hypothesis must come from that evidence, not from preference.
3. **Define the delta.** Write one hypothesis and the smallest set of overrides that tests it.
   - The target model cannot be overridden. If the user wants another model, stop and use the new experiment steps.
   - Changing the builder, harness, evaluation, or skill revision changes the treatment. Prefer changing one factor so the result can be attributed to it. If several factors change, list them and state that the result cannot be attributed to any one of them.
4. **Choose the starting engine.** Set `implementation.starting_scaffold` and the code-reuse and dependency fields under `implementation` explicitly. Continuing from the base's final engine revision and starting from scratch are different experiments; do not leave this implicit.
5. **Write the derived contract.** Create `experiments/<experiment-id>/contract.json` with its own `experiment_id`, `status`, `description`, and freeze time, an `extends` entry pinned by path, commit, and hash, and the overrides. Do not copy the base.
6. **Check it.** Run the check command from [the SOP](../SKILL.md). Show the user the list of changes it prints and confirm that it is exactly the intended delta. A misspelled override key or an unresolved field in the effective contract must be fixed, not ignored.
7. **Plan the comparison.** Results are not inherited. To compare with the base, run the base engine again under the same evaluation, hardware, and resource settings as the derived run, or show that the conditions are identical to those of an existing base run. Keep matched comparisons separate from best-permitted-system comparisons.
8. **Freeze.** Commit the derived contract on a codex/ branch and record its commit. Hand off to [the build reference](build.md) with the effective contract. In the final report, state what changed from the base, what stayed the same, and whether the conditions are matched.

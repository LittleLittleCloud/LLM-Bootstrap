# Build the engine

Optional stage 3 of the [experiment SOP](../SKILL.md), for when an engine is written or changed as part of the work. Skip it when an existing engine is only set up. The SOP's rules on links, the read-only plugin, and publishing apply here. Resolve links relative to this file.

Read [the experiment protocol](experiment-protocol.md) and the selected frozen experiment (for a derived experiment, its resolved effective experiment). Who or what writes the engine is not recorded and not restricted: an agent, a person, or both may do it. If the platform or target model is unresolved, return to [the planning reference](plan.md) before dependent work.

Implement in a separate engine workspace or feature branch, with platform-native choices based on the experiment. Reference engines may supply independent outputs to compare with.

Get the minimal model execution path correct before optimizing: weight and tokenizer loading, tensor layouts, operators, attention and recurrent state, cache reset behavior, and generation. Check representative input lengths before calling the engine validated. Evaluation code is owned by this repository ([evaluation protocol](evaluation-protocol.md)); do not write, edit, or work around it, and use only the pinned evaluation for measurements that go into an experiment.

Profile the actual runtime. Choose changes from measured bottlenecks, state the hypothesis, and keep the commit of each attempt. Use a fixed small workload for iteration and the pinned evaluation for results. Do not select only the fastest runs or silently fall back to another backend, and state any change of precision, caching, or resource limits.

Commit the engine: the experiment names it by a full 40-character commit, so the revision that is evaluated must exist before the experiment is frozen. Keep generated binaries, weights, private traces, and credentials out of project Git history.

Hand the commit and complete run instructions to [the evaluation reference](evaluate.md).

---
name: bootstrap-evaluate
description: Evaluate LLM-built inference engines against a frozen experiment contract, reconciling correctness, per-request performance, resources, baseline comparability, human assistance, and self-hosting evidence.
---

# Evaluate and report

Read [the experiment protocol](../../docs/experiment-protocol.md), the frozen contract (for a derived contract, its resolved effective contract), and the candidate's runtime/build instructions. Use [the record template](../../experiments/TEMPLATE.md) for results. If reviewing historical evidence, preserve its original configuration and mark unavailable fields rather than rerunning or inventing them.

Resolve bundled links relative to this SKILL.md file, not the current working directory. The plugin root is two directories above this file. Treat the installed plugin as read-only: copy the template and write reports and evidence in the user's selected project workspace, never in the plugin installation/cache. Do not rely on the plugin repository's AGENTS.md being loaded by the host.

Use English for project writing, preserving literal inputs, identifiers, commands, hashes, and raw evidence. Use codex/ feature branches and pull requests for project changes; merge only with explicit user authorization. Do not publish weights, credentials, private prompts, or unreviewed agent transcripts; record hashes and access limitations instead. Keep planned targets, prior external evidence, and measurements from these skills distinct.

Verify actual hardware, model hashes, deployed runtime identities, and allowed settings. Execute correctness gates and baseline/candidate measurements within existing authorization. Run competing GPU loads serially, isolate generated-code assertion evaluation, distinguish warm-up from formal rounds, and retain all failures/repetitions.

Collect complete per-request native metrics and client TTFT observations. Reconcile request/token totals with the evaluation harness; report coverage. Compute throughput from sums. Preserve the N−1 versus command-timing distinction and report missing values explicitly. Report quality, resource gates, and application duration alongside speed.

Audit comparison conditions before deriving a speedup. Separate matched engine comparisons from best-permitted-system comparisons; disclose precision, speculation, memory limits, cache, workload, and timing differences. Interactive agent traces can generate different requests, so task time alone does not isolate engine changes. Treat a single cohort as preliminary evidence.

Report numerical correctness, task assertion results, memory/swap, variation, cost, budget, human interventions, and gaps to every acceptance criterion. Verify any self-hosting claim with builder identity, routing/runtime transition, and subsequent development evidence. Historical measurements without trajectories do not prove autonomy.

Create a reviewable results change independently of implementation adoption. When a JSON run record is used, its shape follows the `ExperimentRun` schema in [the protocol schema](../../schema/experiment-protocol.openapi.json); schema validity shows structure only, not correct measurements or an accepted result. Link source revisions, evidence hashes/access limitations, and failures. State “best among tested configurations” unless baseline coverage supports a bounded SOTA claim. Leave unmet or unmeasured criteria open; results publication does not imply acceptance or authorize merge.

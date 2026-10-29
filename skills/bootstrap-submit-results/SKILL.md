---
name: bootstrap-submit-results
description: Submit a finished LLM Bootstrap experiment's results to the main repository as a reviewable pull request. Assembles the contract, report, run records, and result documents, scans for private material, validates with the repository's own checks, and opens the PR from a fork only after the user authorizes it. Use when an experiment has results ready to publish.
---

# Submit experiment results

This skill turns finished experiment records into a pull request against the LLM Bootstrap repository, `https://github.com/LittleLittleCloud/LLM-Bootstrap`. It does not run experiments (use bootstrap-experiment-sop for that) and it never merges.

Resolve bundled links relative to this SKILL.md file, not the current working directory. This skill needs nothing outside its folder: the authoritative rules and the validation tools come from a fresh clone of the repository, as below. Treat the installed plugin as read-only. Use English for project writing, preserving literal identifiers, commands, hashes, and raw evidence. Use a codex/ branch and a pull request, and merge only with explicit authorization from the repository's maintainers. Do not publish model weights, credentials, private prompts, or unreviewed agent transcripts; record hashes and access limitations instead.

## Preconditions

Check each one. If any fails, stop and say which, rather than filling the gap yourself.

1. The project workspace has `experiments/<experiment-id>/` with a frozen `contract.json`, `report.md`, and `runs/<run-id>/run.json` with the evaluation result documents each run references beside it.
2. The contract was committed in the project's repository before the run, and every run's `contract.revision` is that commit.
3. The report is finished: every acceptance criterion is marked passed, failed, or open; the feedback section is filled in; the implementation commit or pull request is linked. Results go in their own pull request, separate from any engine implementation.
4. All runs are included, failed, interrupted, and neutral ones too. Dropping the unfavorable ones is not allowed.
5. The user has said, in this conversation, that you may push and open a pull request. Ask before step 6; do not infer it.

## Steps

1. **Scan for private material.** In the experiment directory look for weights, credentials, private prompts, agent transcripts, machine addresses, and anything over 1 MiB. For example: `grep -rn -I -E '(BEGIN [A-Z ]*PRIVATE KEY|api[_-]?key|secret|token|password|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})' experiments/<experiment-id>` and a search for IPv4 addresses. Report every hit to the user before going on. Never copy `evidence/`: local-only evidence appears in the records as a hash and an access limitation only.
2. **Prepare a clean checkout.** In a scratch directory outside the project workspace, fork the repository if you lack write access (`gh repo fork LittleLittleCloud/LLM-Bootstrap --clone=false`), clone it, fetch the latest `main`, and create the branch `codex/results-<experiment-id>`. Read the experiment protocol in that checkout, `skills/bootstrap-experiment-sop/references/experiment-protocol.md`, section "Experiment records". It is the authority for the layout.
3. **Check the base.** If the contract is derived, its base contract must already be in the checkout at `extends.path` with the pinned hash. If it is not, stop: the base experiment's records must be submitted first or in the same pull request.
4. **Copy the records exactly.** Copy `contract.json`, `report.md`, and `runs/` into `experiments/<experiment-id>/` of the checkout byte for byte. Do not reformat or edit any pinned file; a changed byte breaks its recorded hash. Only these files are accepted: `contract.json`, `report.md`, `runs/<run-id>/run.json`, and `runs/<run-id>/{baseline,candidate}-<engine>.json`. If a path inside a run record does not resolve in the checkout, correct that run record's path only and say so in the pull request.
5. **Validate in the checkout.** Run `npm ci`, then `npm test`. The tests build the leaderboard index from `experiments/` with schema validation, check every pinned hash, and enforce the accepted file list. Then run `node tools/leaderboard/build-index.mjs . --out <scratch>/index.json --require-validation` and note how many entries it wrote and their quality-gate states. Check the evaluation pin of each run: the recorded `revision` must be a commit in the repository's history (`git merge-base --is-ancestor <revision> origin/main`), and `git show <revision>:evaluations/<evaluation-id>/evaluation.json | shasum -a 256` must equal the contract's evaluation `sha256`. Fix the cause of any failure; do not weaken a check.
6. **Get authorization.** Show the user the file list (`git diff --stat`), the scan result, the validation output, and the draft pull request body (from [the template](assets/pull-request-template.md)). Ask for explicit permission to push and open the pull request, and wait for it.
7. **Push and open the pull request.** Commit with the message `Add results for <experiment-id>`, push the branch to the fork or repository, and open the pull request against `main` with the title `Add results for <experiment-id>` and the filled-in template as its body. Give the user the URL.
8. **Stop there.** Do not merge, approve, or enable any deployment. If a reviewer asks for changes, push them as new commits. If a result later turns out to be wrong, record the correction as a new run directory or an amendment; never edit files that were already submitted.

## What a reviewer will check

The contract was frozen before the run; the evaluation is pinned by a real commit and a matching hash; every pinned hash matches; failures and interruptions are present; missing values read "Not obtained" or unavailable, never zero or none; comparisons separate the matched and best-permitted tracks; the claims are no stronger than the baseline coverage supports; the feedback section is specific; and nothing private is included.

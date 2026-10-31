# Evaluation protocol

This protocol defines how an endpoint is evaluated. It is separate from the [experiment protocol](experiment-protocol.md), which defines what an experiment fixes and claims. Its structure is formalized in the [evaluation schema](../assets/schema/evaluation-protocol.openapi.json), which checks shape only. This prose and the skills remain authoritative.

## Repository-owned evaluation

Evaluations are defined by the LLM Bootstrap repository (`https://github.com/LittleLittleCloud/LLM-Bootstrap`), not by individual experiments. An evaluation's definition and its code live under `evaluations/<evaluation-id>/` in that repository and change only through reviewed pull requests to it. An experiment selects an evaluation by id, repository revision, and definition hash. It does not carry, replace, or patch evaluation code, and it does not set the evaluation's repetitions or sizes.

The builder LLM does not write or edit evaluation definitions, code, or scoring during an experiment, so it cannot shape how its own engine is judged. A needed change is made in this repository outside any experiment and produces a new revision, which is a different evaluation. Earlier results stay tied to the revision they used.

## Obtaining an evaluation

Evaluations are not bundled with the skill; the repository above is the only source. Take them from the latest commit of its `main` branch:

1. When planning, resolve that commit: `git ls-remote https://github.com/LittleLittleCloud/LLM-Bootstrap.git refs/heads/main`.
2. Read the definition at exactly that commit, for example in a scratch clone checked out at it, outside the project workspace and outside any installed plugin. Choose a `released` definition.
3. Record the full commit as the experiment's `evaluation_revision` and the definition file's sha256 as `evaluation_sha256`. Later stages use the recorded revision, never a newer `main`.

Do not use an evaluation copy that shipped with an installed plugin, was cached earlier, or has local changes. Run the evaluation from the pinned revision, and never edit the report it exports.

## Evaluation definition

Each evaluation has a definition file, `evaluations/<evaluation-id>/evaluation.json`, that fixes:

- The plan: what each test asks, its sizes, repetitions, and timeouts.
- The profiles: named reductions of the plan. The plan without a name is the full one.
- The code that carries out the evaluation, each file with a role (a driver that runs it, or an assertion evaluator that verifies the driver), a path inside the evaluation directory, and a content hash.

A definition is a `draft` or `released`. A released definition has at least one driver, and every file exists in the repository and matches its hash. A draft cannot be used for formal runs. When a file changes (a maintainer task), run `node tools/evaluation/refresh-hashes.mjs <evaluation-id>` to update its hash in the definition. The repository tests fail until the hashes match.

Evaluations in the repository at the time of writing (the commit you resolved is authoritative):

| Evaluation | Status | Report | Purpose |
| --- | --- | --- | --- |
| `endpoint-bench` | released | `EvaluationReport` | A quick benchmark of an OpenAI-compatible chat endpoint from a web page: conform, speed, thinking, decode, prefill, needle, and cache. |

Earlier measurements with external drivers (the Infer.NET records) are prior evidence only: they used different workloads and timing boundaries, and their correctness check did not meet this protocol.

## The endpoint-bench evaluation

`endpoint-bench` is modeled on [ZebraBench](https://sujee.github.io/zebrabench/), a browser benchmark for inference endpoints. It asks for an **endpoint URL** and an optional **token**, then a **model** from the list the endpoint reports. It asks for nothing else: no machine, no environment, no experiment, no engine. The evaluator is repository-owned code under `evaluations/endpoint-bench/src/`, served as the site's Evaluate page. A person, or an agent driving a browser by computer use, opens the page built from the pinned revision, enters those inputs, selects tests and a profile, and exports the report.

- **Run the pinned revision.** The page shows the evaluation revision and definition hash it was built from. They must equal the experiment's `evaluation_revision` and `evaluation_sha256`. If the deployed site is at another revision, check out the pinned commit and serve the site from it (`cd site && npm ci && npm run dev`). Never run from a modified checkout: the page marks a build with uncommitted changes, and the report carries `build_dirty: true`. Such a report does not identify the code that produced it, so it is not evidence for a result; commit the change or restore the checkout, rebuild, and run again.
- **Browser requirements.** The endpoint must answer cross-origin requests from the page's origin and allow the `authorization` and `content-type` headers. A page served over https can reach a loopback http endpoint in Chrome and Firefox; Safari blocks it, so serve the page locally or use another browser. The token lives in memory for the run and is never stored or exported.
- **Timing.** The browser's monotonic clock times each streamed request. Token counts come from the endpoint's reported `usage`; a request whose stream reports none fails. Percentiles are nearest-rank. A missing measurement is `null`, never zero. The runner can also stream each request's start, deltas, and end to a display as they happen; that feed is for watching only and is never part of the report.
- **One model per report.** Evaluate each model, engine, or configuration separately, serially, on the same device, and keep every report.
- **Rejected fields.** If the endpoint rejects `max_tokens`, `temperature`, `stream_options`, or `min_tokens` and `ignore_eos`, the evaluator retries once without or with the replacement the endpoint names (`max_completion_tokens`) and records the change as `compat`. A change that remains in force applies to all later requests.

### The seven tests

| Test | What it asks | Headline |
| --- | --- | --- |
| `conform` | Does the endpoint behave like the chat API the other tests rely on? | Every required check passes |
| `speed` | Raw output speed from a short prompt that asks for endless lowercase words, after one excluded warm-up | `tokens_per_second` p50, TTFT p50 |
| `thinking` | A medium reasoning task, asked with the endpoint's own thinking and with thinking switched off | Accuracy, format compliance, reasoning and answer tokens |
| `decode` | Output speed at fixed output lengths (100, 1000, and 4000 tokens), with the length forced | Decode `tokens_per_second` p50 and p90 by length |
| `prefill` | How fast long prompts are digested, from 10k to 1M input tokens that fit the context window | Effective input tokens per second by size |
| `needle` | One access code hidden at 5, 25, 50, 75, and 90 percent of a document that fills 90 percent of the context window | Recall by depth |
| `cache` | One question asked as a short prompt, a padded prompt, and a padded prompt with a nonce, each cold once and then repeated | Cache hit percent, TTFT reduction |

A report names the tests it selected, and each selected test has a status: `complete`, `partial` (some requests failed), `error`, `cancelled` (the person stopped the run, and finished measurements are kept), or `skipped` (`prefill` only, when no size fits the window).

#### conform

Each check is required or optional. A failed required check means the other results cannot be trusted; an optional check only describes the endpoint.

| Check | Required | Passes when |
| --- | --- | --- |
| `models-list` | yes | `GET /models` returns a list that contains the model |
| `chat-completion` | yes | a non-streamed completion has `choices[0].message.content`, a `finish_reason`, and `usage` token counts |
| `chat-stream` | yes | a streamed completion carries content deltas |
| `stream-usage` | yes | the stream ends with a usage chunk with positive prompt and completion counts |
| `max-tokens` | yes | an output limit of 5 gives at most 5 tokens and `finish_reason` `length` |
| `system-message` | yes | a system message is accepted |
| `cached-tokens` | no | usage carries `prompt_tokens_details.cached_tokens` |
| `stop-sequence` | no | a stop sequence ends the output before it |
| `deterministic` | no | two identical requests at temperature 0 give the same text |
| `error-shape` | no | an unknown model gets a 4xx with an `error` object |

#### speed and decode

- **TTFT** runs from request dispatch to the first non-empty content or reasoning delta (`speed`), or to the first visible content token (`decode`, where reasoning deltas are ignored).
- **Speed** divides the completion tokens by the streaming time after the first delta. Reasoning tokens count.
- **Decode** divides visible output tokens minus one by the time from the first to the last visible token. The first token is not part of the interval. Reasoning tokens are excluded; the endpoint's reasoning count is used when reported, otherwise the share is estimated from streamed characters. A run that shows reasoning is marked `reasoning_required`.
- **Forced length.** `decode` sends `min_tokens` equal to the length and `ignore_eos`, so the model cannot stop early. If the endpoint rejects them, only `max_tokens` is sent, and the summary says `fixed_length_applied: false`.
- Each length has one excluded warm-up and the planned number of measured runs, summarized by p50 and p90.

#### thinking

Each question is a fresh table of rows with an id, a unique name, and a unique score; the model must answer exactly one line, `<id>|<name>`, naming the row with the highest score. Row order is shuffled per question, so the answer is not in a fixed position. The same questions are asked with the endpoint's own behavior (`default`) and with `chat_template_kwargs.enable_thinking = false` (`no-thinking`), after one excluded warm-up each. The answer must be the entire final content, one line, with a canonical integer id and a name that matches case-insensitively. A failed request counts as incorrect and non-compliant. Accuracy carries its sample count and the standard error of a proportion; format compliance is separate, so "could not find the maximum" differs from "could not follow the format".

#### needle and prefill

Documents are neutral log lines with one entry that holds an access code. Their size comes from characters per token, measured once with a probe request against the model; the report records it as `chars_per_token`. The answer must be exactly the code. `prefill` keeps the needle at 90 percent and varies the input size; its rate is the prompt tokens the endpoint reports divided by the time to the first token, so it is an effective rate that includes network and queueing. `needle` fills 90 percent of the context window and varies the depth.

The **context window** is taken from the model list when the endpoint reports one (`context_length`, `max_model_len`, `n_ctx`, and similar fields), and otherwise assumed to be 32768 tokens. The report states which (`context_window.source`). A size larger than the window is skipped, never failed.

#### cache

The question is `What is the capital of France? Answer with the city name only.` The `short` prompt is the bare question, below the minimum most providers cache. The `padded` prompt surrounds it with filler up to the planned size (at most half the context window), byte for byte identical on every request, so a cache can serve it. The `busted` prompt prepends a fresh nonce to the padded prompt on every request, so nothing can be reused. Each variant sends one cold request and then the planned repeats. The cache hit percent is cached tokens over prompt tokens of the repeats, as the endpoint reports them; an endpoint that reports none is recorded as `cache_reported: false` and the hit percent is `null`, not zero. The TTFT reduction is the cold TTFT against the repeats' p50. Nothing about pricing is measured.

### Profiles

`full` runs the plan. `quick` runs the smaller plan of the definition, for a first look. A report of any other profile is preliminary evidence, and the leaderboard says so.

## The report

One report is the measurement of one run: one model of one endpoint. It is stored at `experiments/<experiment-id>/evaluation/<subject>/<YYYYMMDD-HHMMSS>.json`, where the name is `started_at` in UTC and the subject is `candidate` or the name of one of the experiment's `baseline_engines`. The report pins the evaluation (id, repository commit, definition hash) and must cite the evaluation of its experiment. It holds the seed, the context window, the profile, the status and failures, and for each selected test its plan settings, every measured request (timings and token counts, with a short answer where one is graded), and a summary. It holds no prompt, no model output beyond a graded answer of at most 80 characters, no token, and no address: the endpoint is recorded only as `loopback`, `private-network`, or `remote`.

What a report does not say matters as much. It does not say which engine, hardware, or weights served the endpoint, because the evaluator cannot see them. The experiment states those, and the person who submits the report states in the pull request how the endpoint was started and why it is the engine of the subject. A baseline and a candidate are separate reports, and so is every repeated, failed, or interrupted run. A correction is a new report, never an edit.

### Headline metrics

Experiment thresholds (`goal_thresholds`) and the leaderboard read these names, defined from the report:

| Metric | Meaning |
| --- | --- |
| `conform_passed` | 1 when every required conformance check passed, else 0 |
| `speed_tokens_per_second_p50` | `speed` summary, tokens per second |
| `speed_ttft_ms_p50` | `speed` summary, milliseconds |
| `decode_tokens_per_second_p50` | `decode` at 1000 output tokens, or the longest length that has a value |
| `prefill_tokens_per_second_p50` | `prefill` at the smallest size that has a value |
| `needle_accuracy` | `needle` recall over every depth, between 0 and 1 |
| `thinking_accuracy` | `thinking` accuracy in the `default` variant, between 0 and 1 |
| `cache_hit_pct` | `cache` hit percent of the `padded` prompt |

A threshold on a metric that the report lacks is unmet, not satisfied.

### Reading a report

Check these before trusting a number, and state the ones that apply in the results pull request description.

- **`build_dirty`.** Present means the report is not evidence (see "Run the pinned revision").
- **`context_window.source` is `assumed`.** Sizes above the guess were skipped, not failed, and `needle` was sized against the guess. Read the long-context results as covering only the sizes that ran.
- **A `thinking` that did not think.** If `default` reports `reasoning_tokens` of 0 and gives the same answers as `no-thinking`, the endpoint did not reason, hides its reasoning, or ignores the switch. The accuracy then describes a non-reasoning mode and says nothing about thinking.
- **A short `speed` run.** If `completion_tokens` is far below the plan's `max_tokens`, the model stopped on its own. The rate covers a few tokens and counts the first one without its time, so it runs high. For a rate to compare, read `decode`, which forces the length.
- **Rates that fall with length.** `decode` at a longer output, and `prefill` and `needle` at a larger input, are slower than the short cases. Compare engines at the same lengths, never a short rate against a long one.
- **`needle` size and certainty.** The actual `prompt_tokens` can exceed the target by several percent, because characters per token is an estimate; what matters is that the prompt fit. A perfect score has a standard error of 0 by construction, so a small sample still proves little.
- **`cache`.** The `short` and `busted` prompts are controls and should show a hit near 0 and no TTFT gain. A `padded` hit of 0 with `cache_reported` true means the endpoint reports the field but does not reuse the prefix: prefix caching is off, unsupported, or reset between requests.
- **Duration.** A `full` run against a slow endpoint takes over an hour, because each long-context request can take minutes. Use `quick` while developing and plan the time for a full run.

## Correctness gates

The evaluation cannot show numerical equivalence with a reference implementation, and it is not required. The quality gate asks whether the endpoint can be trusted and whether the model still answers correctly. `conform` must pass its required checks. `thinking` and `needle` are rule-scored, with no judge model. The experiment judges them against a baseline engine of the same model: a candidate passes when no accuracy falls below the best baseline's by more than two standard errors of the difference, and at least one accuracy was scored in full. The leaderboard applies that rule, and a baseline passes on verification alone because it defines the reference. State the rule in the experiment's `goal_quality_gate`. A candidate is not ranked unless it passes. A small sample gives a wide standard error, so a pass shows only that the engine is not badly broken.

## Verifying the evaluator

The evaluator is verified in this repository's tests, not at run time. In-memory reference engines under `evaluations/endpoint-bench/reference/` answer through the evaluator's own client, so its timing, grading, and aggregation run unchanged. The tests assert that known rates are recovered, that a short prompt is not cached while a padded one is and a nonce defeats the cache, that wrong answers score zero and absent usage or cached tokens are not guessed, that rejected fields are handled, that failures and cancellation are reported and still validate, and that a report holds no token, address, or prompt. The reference engines are pinned with the evaluator, so a change to either is a new evaluation revision.

## Limits

A browser measures what a browser sees: network time, queueing, and proxy overhead are included, and a remote endpoint cannot be told apart from a slow engine. It cannot sample memory, swap, power, or thermal state, so an experiment that needs them states and checks them itself. A run is short; it is not a load or soak test and does not show sustained throughput, concurrency scaling, or cold start. Compare reports only when the model, context window, profile, and endpoint class match, and treat a single run as preliminary evidence.

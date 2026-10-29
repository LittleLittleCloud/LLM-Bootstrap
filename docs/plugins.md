# Plugin packaging and installation

## One package, two formats

The repository root is the plugin root for both formats. No generation step, duplicated skills, symlinks, VS Code extension, or runtime dependency is needed to use it.

| Client format | Manifest | Skill discovery |
| --- | --- | --- |
| Agent Plugins 1.0 | [plugin.json](../plugin.json), with the canonical 1.0.0 `$schema` | Immediate subdirectories of the root skills directory containing a SKILL.md file. |
| Claude Code | [.claude-plugin/plugin.json](../.claude-plugin/plugin.json) | The same root skills directory, using Claude's default discovery. |

The portable manifest intentionally contains metadata only: Agent Plugins 1.0 does not allow top-level skill paths, agents, commands, or hooks. The Claude manifest does not need a custom skills path either. Both manifests keep their name, version, and shared metadata identical. The [.claude-plugin/marketplace.json](../.claude-plugin/marketplace.json) catalog lists this entire root as `./`, so installation retains the shared resources. This is a Claude-compatible marketplace, not a marketplace format defined by Agent Plugins 1.0.

The package ships two skills:

| Skill | Purpose | Claude invocation |
| --- | --- | --- |
| [bootstrap-experiment-sop](../skills/bootstrap-experiment-sop/SKILL.md) | Run a new or derived experiment end to end: plan, build, evaluate, and report, with gates between stages. | `/llm-bootstrap:bootstrap-experiment-sop` |
| [bootstrap-submit-results](../skills/bootstrap-submit-results/SKILL.md) | Submit finished experiment results to this repository as a reviewable pull request. | `/llm-bootstrap:bootstrap-submit-results` |

Other clients control their own menus and command names; use their skill picker rather than assuming Claude's namespace syntax. There are no bundled custom agents, hooks, MCP servers, auto-running commands, or weights. The only scripts are the dependency-free [contract resolver](../skills/bootstrap-experiment-sop/scripts/resolve-contract.mjs) and the [contract check](../skills/bootstrap-experiment-sop/scripts/check-experiment.mjs) built on it, which the experiment SOP asks the agent to run, and the Python evaluation scripts under [evaluations/](../evaluations/engine-api-conformance/evaluation.json), which need Python 3.9 or newer and nothing else. Nothing runs them automatically, and the evaluation scripts verify their own hashes before running. These skills guide an existing agent; they do not supply a separate agent runtime or automatically grant tool permissions.

## Install with Agent Plugins / VS Code

Use a client that supports Agent Plugins 1.0. In VS Code:

1. Enable `chat.plugins.enabled` if plugin support is disabled or required by your version. Organization policies may restrict installation.
2. Run **Chat: Install Plugin from Source** in the Command Palette.
3. Enter `https://github.com/LittleLittleCloud/LLM-Bootstrap.git`, or the absolute path of a local checkout for unpublished changes.
4. Confirm the plugin is enabled for the intended harness and workspace in the Agent Customizations editor.
5. Start a fresh chat and confirm both skills appear. Invoke `bootstrap-experiment-sop` for a planning-only task before authorizing an experiment.

For live local development without installing a copy, add your checkout to the user setting `chat.pluginLocations`:

```json
{
  "chat.plugins.enabled": true,
  "chat.pluginLocations": {
    "/absolute/path/to/LLM-Bootstrap": true
  }
}
```

These settings are client-specific and may be experimental. Do not commit machine-specific paths to the plugin. VS Code recognizes the schema-bearing root manifest as Agent Plugins 1.0; Claude Code uses its own manifest. A client supporting only legacy Copilot manifests is not necessarily an Agent Plugins 1.0 client.

VS Code can also browse the Claude-compatible marketplace by adding `LittleLittleCloud/LLM-Bootstrap` to its marketplace sources and installing `llm-bootstrap`. Adding a marketplace alone does not install its plugin. Use only one installation method per client to avoid duplicate skills.

## Install with Claude Code

Use a Claude Code version supporting plugins. Inside a Claude Code session:

```text
/plugin marketplace add LittleLittleCloud/LLM-Bootstrap
/plugin install llm-bootstrap@llm-bootstrap-marketplace
```

Remote installation requires these changes to have been published first. For an unpublished checkout, launch a session from your **experiment workspace** with the plugin directory loaded:

```sh
claude --plugin-dir /absolute/path/to/LLM-Bootstrap
```

Alternatively, test the local marketplace from your shell:

```sh
claude plugin marketplace add /absolute/path/to/LLM-Bootstrap
claude plugin install llm-bootstrap@llm-bootstrap-marketplace
```

Use `/plugin` to confirm that the plugin is enabled, start a fresh session as needed, and invoke `/llm-bootstrap:bootstrap-experiment-sop`. The skill should read the bundled protocol and templates, ask for unresolved essential configuration, and leave the installed package unchanged. Do not interpret skill discovery as a completed engine experiment.

## Bundled resources and workspace outputs

Each skill is self-contained. The experiment skill carries its protocols, report template, schemas, prior evidence, and scripts inside `skills/bootstrap-experiment-sop/`; the submission skill works from a fresh clone of the repository. Links resolve from each `SKILL.md`, not from the session's current directory. Evaluations are the one exception. They are fetched from the repository's latest `main` commit, so running an evaluation needs network access.

Treat the plugin installation/cache as read-only. Copy the report template to a new directory in the user's project, write and resolve the draft contract there, and keep implementation code and new evidence in that workspace. Updates may replace plugin files. Do not place weights, credentials, private prompts, or unreviewed trajectories in the distributable package. A root AGENTS.md is not automatically injected by plugin installation; essential workflow constraints are included in the skill and its protocol.

Record the exact plugin repository revision and hashes of the instructions actually supplied to the builder. The plugin version alone is not an immutable experiment treatment. Planned targets and prior Infer.NET measurements remain separate from results produced using these skills.

## Validate and maintain

Repository checks require Node.js 22 or later and the locked dev-only dependencies (JSON Schema and OpenAPI validators); plugin users need neither. From the repository root:

```sh
npm ci
npm test
git diff --check
```

The checks cover the package's manifest field subset, synchronized metadata, marketplace source, skill names/descriptions, local Markdown resource containment, JSON resources, and relocation into a path containing spaces. They also validate the [protocol schema](../skills/bootstrap-experiment-sop/assets/schema/experiment-protocol.openapi.json) against the OpenAPI 3.1 schema and strict JSON Schema 2020-12, and check it against a draft fixture and synthetic fixtures. These are repository regression checks, not a replacement for official client validation or end-to-end installation tests. CI runs the same checks.

When Claude Code is available, also validate the manifest and marketplace explicitly:

```sh
claude plugin validate .claude-plugin/plugin.json
claude plugin validate .claude-plugin/marketplace.json
```

Before distribution, test installation and skill discovery in both intended clients using the steps above. Keep any unperformed client smoke tests explicitly unverified. For releases, update the version in both plugin manifests and the marketplace entry together. Use a codex/ feature branch and a pull request; merge only with explicit maintainer authorization. Packaging checks never run hardware experiments.

## Format references

- [Agent Plugins 1.0 specification](https://agent-plugins.org/specification)
- [Agent Plugins manifest schema](https://agent-plugins.org/schemas/1.0.0/plugin.schema.json)
- [VS Code plugin authoring reference](https://code.visualstudio.com/docs/agents/reference/agent-plugin-reference)
- [Claude Code plugin manifest reference](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code marketplace documentation](https://code.claude.com/docs/en/plugin-marketplaces)
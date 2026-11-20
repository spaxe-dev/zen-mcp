# Agent skill

Zen MCP ships an agent skill in [`skills/zen-mcp/`](../skills/zen-mcp/SKILL.md).
It teaches an agent that already has the server connected how to use it well:
background research, comparisons, evidence checks, tab triage, page monitoring,
safe interaction, and cleanup.

It is not the server manual and not the contributor guide. Server setup lives
in the [README](../README.md); development rules live in `AGENTS.md`.

## What the skill contains

| File | Purpose |
| --- | --- |
| `SKILL.md` | The operating manual: identity, mental model, first move, perception hierarchy, playbooks, evidence discipline, etiquette, safety, efficiency, and completion. About 1.9k tokens. |
| `references/workspace-management.md` | Spaces, folders, pins, essentials, split view, Glance, containers, sessions, templates. |
| `references/research-workflow.md` | Single-page answers, multi-source research, comparisons, monitoring, PDFs, blocked pages. |
| `references/evidence-and-verification.md` | Claim states, verification parameters, outcome codes, batch limits, what matching cannot prove. |
| `references/tab-management.md` | Tab ids, search, audit, grouping, closing policy, sessions, windows. |
| `references/browser-interaction.md` | Interactive reads, ref lifecycle, click/type, effect signatures, waits, frames, forms. |
| `references/safety-and-recovery.md` | Consent, Pause, Stop, read-only, allowlist, failure matrix, incident handling. |
| `references/tool-selection.md` | Every tool by intent, with parameters, defaults, limits, and capabilities that do not exist. |
| `evals/tasks.md` | Eight scenarios with pass criteria for evaluating an agent that follows the skill. |

The main file is deliberately small. References are loaded only when the agent
needs the detail, which keeps the context cost low.

## Before you install

You need both pieces:

1. **The Zen MCP server**, configured in your MCP client and able to launch
   Zen. See [Quick start](../README.md#quick-start). Installing the skill does
   not configure the server.
2. **The skills CLI**, run through `npx`. Its current release requires Node.js
   22.20 or newer. The Zen MCP server itself requires Node.js 22 or newer.

The skill is instructions, not permission. Read-only mode, the domain
allowlist, consent, Pause, and the audit log are enforced by the server whether
or not the skill is installed.

## Install

```sh
npx skills add spaxe-dev/zen-mcp
```

The CLI finds `skills/zen-mcp/SKILL.md`, asks which agents to install for, and
offers a project install (default) or a global one (`-g`). This repository ships
exactly one skill, so `--skill zen-mcp` is optional but unambiguous:

```sh
npx skills add spaxe-dev/zen-mcp --skill zen-mcp -a claude-code -a opencode
npx skills add spaxe-dev/zen-mcp --skill zen-mcp -g -a codex
```

Non-interactive:

```sh
npx skills add spaxe-dev/zen-mcp --skill zen-mcp -a claude-code -y
```

Project installs land in the agent's project skills directory, for example
`.agents/skills/zen-mcp/` or `.claude/skills/zen-mcp/`. Global installs land
under your home directory. The CLI can symlink (default) or copy (`--copy`).

### Verified install

Verified with `skills@1.9.0` against both a local checkout and the published
GitHub source:

```sh
npx skills add spaxe-dev/zen-mcp --skill zen-mcp -a opencode -y --copy
```

Result: `Found 1 skill`, installed `.agents/skills/zen-mcp/` with `SKILL.md`,
the seven references, and `evals/tasks.md`. `npx skills list` reported the skill
as tracked with source `spaxe-dev/zen-mcp`, and `skills-lock.json` recorded the
GitHub source and commit. The local-path form behaves the same.

## Supported agents

The skill is plain Markdown with YAML frontmatter (`name`, `description`), so
any client that implements the Agent Skills format can read it. The `skills`
CLI supports Claude Code, Codex, Cursor, OpenCode, and a long list of others;
run `npx skills add spaxe-dev/zen-mcp --list` to see the skill without
installing, and name your agent with `-a`.

Zen MCP's own onboarding supports 28 clients (see the README). That list is
about writing the server entry into a client config. It is a separate concern
from where the skill file is installed, and this page does not claim the skill
has been exercised in every client.

## Update

```sh
npx skills check              # any updates or local modifications?
npx skills update zen-mcp     # reinstall from the source
```

Project installs record the source commit and a content hash in
`skills-lock.json`. Skills installed with `--copy` or by hand are static copies:
update them by reinstalling or re-copying. If you edited an installed skill
locally, `skills check` reports it as modified before overwriting it.

The skill tracks the repository, not the npm release. The npm package ships
`dist`, `README.md`, and `LICENSE` only, so `npm install -g @spaxe-dev/zen-mcp`
does **not** install the skill.

## Confirm it is available

```sh
npx skills list
```

Then start a fresh agent session (restart the client if it caches skills) and
ask something that only the skill answers, for example:

> "Before you browse, what do you check, and where does multi-source research
> go?"

A loaded skill answers with the first-move checks (`zen_status`,
`zen_spaces_list`, `zen_tabs_list`), a background space, and evidence
verification. If the agent invents a screenshot tool or proposes to attach to
your everyday browser, the skill is not loaded.

## Manual install

If you do not want the CLI, copy the directory into the skills location your
client documents:

```sh
mkdir -p ~/.claude/skills
cp -R skills/zen-mcp ~/.claude/skills/zen-mcp
```

The folder must contain `SKILL.md` at its root, and the frontmatter `name` must
match the folder name (`zen-mcp`). Keep the `references/` directory next to it;
the skill links to those files by relative path.

## Limitations

- The skill cannot grant capabilities or bypass policy. A tool blocked by
  read-only mode is still blocked.
- It assumes Zen MCP tools are exposed under their real names (`zen_status`,
  `zen_read_page`, and so on). A client that renames tools will break the
  references.
- It is written for Zen MCP 0.5.0. The tool surface can change before 1.0.
- The evaluation scenarios in `evals/tasks.md` require a live browser, a free
  Marionette port, and a human to approve consent. They are not run in CI.
- The skill describes the hosted server's behavior, including known limits such
  as hidden PDFs and post-navigation allowlist checks. It does not add
  guarantees the server does not provide.

## Maintainer check

```sh
npm run build
npm run check:skill
```

`check:skill` starts the local server over stdio and validates the skill
against the live tool surface: frontmatter, the 2,000-token budget, every local
link, every referenced file, every `zen_*` identifier, every example argument
name, enum literals, and a denylist of parked capabilities. It also fails if
contributor-only instructions or filesystem paths leak into the consumer skill.

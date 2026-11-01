# Contributing

Thanks for helping improve Zen MCP. This project controls a real browser, so
changes are reviewed for both correctness and blast radius.

## Before you write code

Only issues marked **In progress** on GitHub Project 3 in the `spaxe-dev`
organization are approved to implement. If an issue is not marked that way,
ask in the issue first. Unsolicited pull requests for unapproved work may be
closed.

## Build

```sh
npm ci
npm run build
```

`npm run build` produces `dist/`, including the CLI and the bridge bundle that
is injected into Zen. Do not edit files in `dist/`; they are generated.

## Checks

```sh
npm run typecheck
npm test
```

Unit tests live in `test/unit/` and run without a browser. Keep them fast and
deterministic. At the time of writing `npm test` runs 186 tests: 181 pass on
Windows and 5 POSIX-specific tests are skipped there.

## Live suite

```sh
ZEN_MCP_E2E=1 npm run test:zen
```

The integration suite in `test/integration/` starts a real Zen that Zen MCP
launches itself. It covers three files: `mcp.e2e.test.ts` (the MCP server over
stdio), `zen.e2e.test.ts` (spaces, tabs, reads, evidence, sessions, and
templates), and `security.e2e.test.ts` (ownership, lockdown, consent, pause,
and policy), with 34 test declarations in six groups. The evidence tests check
exact, ambiguous, context-assisted, missing, and cleared matches; background and
focused verification; batch verification with opened and reused tabs; literal
search in one tab and across tabs; the real overlay and scroll position in the
page; and the card text in browser chrome. The security tests click the real
approval card, assert the Marionette listener is closed before approval, reject
a second client, verify Pause blocks requests and Resume restores them, check
that denial quits the browser, and check that shutdown quits it.

The suite needs Zen Browser and a desktop session, so it is not part of CI or
the release workflow, and it must run serially. `npm run test:zen` already sets
`--test-concurrency=1`; do not run the suite in parallel with another instance,
because Marionette uses a single port. Profiles are created under
`D:\tmp\zen-marionette-test` on Windows and `$TMPDIR/zen-mcp-test` elsewhere,
then removed. Override with `ZEN_MCP_TEST_PROFILE` to reuse a specific profile
for debugging.

Manual probes with verbose output live in `scripts/probe-smoke.ts` (bridge, UI,
history, bookmarks) and `scripts/probe-mcp.ts` (stdio MCP round trip).

## Coding expectations

- Use LF line endings.
- Do not add runtime custom JavaScript from other local tools. Chrome scripts
  and bridge operations are fixed server code; agents never supply scripts.
- Anything that touches the bridge, the URL policy, consent, or the launcher
  needs a security review. Explain the trust boundary in the pull request.
- Keep tool input validated with the existing schemas, and keep policy checks
  outside the model.
- Update `README.md`, `CHANGELOG.md`, and the relevant file under `docs/` when
  behavior, user-visible features, or security properties change. The tool
  reference, reading and evidence behavior, configuration, architecture, and
  troubleshooting each have their own document.

## Pull requests

- One focused change per pull request, linked to the approved issue.
- Describe the summary, the user-visible effect, and the test plan.
- Include the commands you ran and their results. Say explicitly if the live
  suite was not run.
- Complete the security checklist in the pull request template.
- Keep generated files, secrets, and unrelated formatting changes out of the
  diff.

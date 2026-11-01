# Security Policy

Zen MCP controls a real browser, so security reports are taken seriously and
handled privately.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.3.x | Yes |
| 0.2.x and older | No |

Only the latest 0.3 release receives security fixes. Upgrade before reporting
a problem that may already be fixed.

## Reporting a vulnerability

Report privately through GitHub Security Advisories:

https://github.com/spaxe-dev/zen-mcp/security/advisories/new

Do not open a public issue, pull request, or discussion for a vulnerability.
Public reports can expose other users before a fix is available.

A useful report includes:

- the Zen MCP version, Node version, operating system, and Zen version,
- how Zen was launched (Zen MCP launch or an existing window),
- the relevant configuration, with secrets and personal paths removed,
- clear reproduction steps,
- what an attacker gains and what they still cannot do,
- logs or traces with tokens, URLs, page text, and account details removed.

A proof of concept is welcome when it does not include real credentials or
private browsing data.

## What to expect

- Initial acknowledgement within 7 days.
- An assessment of severity and whether the report is in scope.
- Fixes and release timing coordinated with you. Please keep the details
  private until a release and advisory are published.
- Credit in the advisory if you want it.

## In scope

- The agent profile, including isolation from the normal Zen profile.
- Bridge authentication and reconnect behavior.
- The URL policy: normalization, domain allowlist, and scheme restrictions.
- Consent and the global Pause control.
- The audit log and its redaction.
- The launcher lockdown: ownership proof and closing the Marionette listener.

## Out of scope

- A compromised operating system account, or a process that already runs as
  the same user with debugger rights. Such a process can read memory and
  inspect arguments regardless of this project.
- A hostile browser extension that already has privileges in Zen.
- Vulnerabilities inside Zen Browser or Firefox itself. Report those to their
  maintainers; Zen MCP only uses the interfaces they provide.
- Findings that require the user to disable consent, read-only mode, or the
  domain allowlist and then hand control to an untrusted agent.

For how these boundaries are implemented, see [docs/security.md](docs/security.md).

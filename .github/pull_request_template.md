## Summary

<!-- What changes, and why. Link the approved issue. -->

## Test plan

<!-- Commands run and their results. Say if the live Zen suite was not run. -->

- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `ZEN_MCP_E2E=1 npm run test:zen` (only when Zen and a desktop session are available)

## Security checklist

- [ ] The change only controls a browser Zen MCP launched and owns.
- [ ] No runtime custom JavaScript from other local tools is introduced.
- [ ] URL policy and read-only mode are considered for every new URL or mutation.
- [ ] The audit log still records calls and does not retain page text or secrets.
- [ ] No page text, tokens, bridge keys, or credentials appear in client-visible
      logs, errors, or cards.
- [ ] Bridge, URL policy, consent, and launcher changes were reviewed for their
      trust boundary.

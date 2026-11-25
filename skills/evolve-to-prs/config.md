# Evolve-to-PRs config

## Commands
- `npm test`, `npm run typecheck`, `npm run build`, `npm run e2e` (core flows in a real browser; must pass).
- `npm run dev` serves the site at http://127.0.0.1:${DW_DEV_PORT:-8787} with a fresh local database.

## Capabilities
- Browser: the `browser` MCP tools (Playwright) can open the local site. Use them to see and click through every
  visual or interaction change at phone (390 px) and laptop widths. Keep screenshots in the run folder.
- Documentation: WebFetch is allowed for docs on hono.dev, developers.cloudflare.com, clerk.com,
  developer.mozilla.org, web.dev and playwright.dev only.

## House rules
- There is no human. Never ask questions. Decide, record the assumption, continue.
- Browser code: any value used after an await, timer or debounce must be checked against the current input or
  session at the moment it is used. Downloads, exports and saves always use the current state.
- Build the thinnest working version first. Delete what the change leaves unused.
- No mention of AI or agents in anything users see.

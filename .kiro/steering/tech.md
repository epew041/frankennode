---
inclusion: always
---

# Technology Stack

## Languages & Frameworks
- Node.js 20+ for the backend (ESM modules; minimal dependencies).
- Vanilla HTML, CSS, and JavaScript for the static frontend. No framework, no build step.

## Libraries
- Built-in global `fetch` (Node 20+) for outbound HTTP and JSON-RPC requests.
- Built-in `node:http` for the small backend server; no web framework.
- Built-in `node:test` + `node:assert` for tests. No external test runner.

## Development Tools
- `npm` scripts in `package.json` for `start` and `test`.
- No bundler, no transpiler, no frontend package manager. Static files are served as-is.

## Technical Constraints
- Read-only: no write operations, no wallet, no API keys, no authentication, no user accounts.
- No frontend build/bundler step; the dashboard is served as static files from `public/`.
- The backend must proxy and cache all four public sources server-side to limit upstream load and absorb outages.
- Must continue functioning when any single source is unavailable.
- All user-facing text must be in English.
- Keep external dependencies to a minimum; prefer Node built-ins. Any new runtime dependency requires a stated reason.

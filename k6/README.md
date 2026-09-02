# k6 load tests

Scaffolding only — no load-test scripts exist yet. Session **T-11** adds
the real `.js` scripts here, targeting `chat-hub-api`'s REST/WebSocket
endpoints against the seeded test dataset (`npm run seed:test`).

## The k6 binary — installed on this dev machine

`k6` (the load-testing tool) is a **standalone Go binary**, not something
`npm install` can provide — the `k6` package in this project's
`devDependencies` is only the official empty placeholder
(https://www.npmjs.com/package/k6), for editor/IDE autocomplete of the
`k6` script API (`import http from 'k6/http'`, etc.); it does **not**
install the binary itself.

**Installed this session** via `winget install --id GrafanaLabs.k6 -e`
(v2.2.0, to `C:\Program Files\k6\k6.exe`, added to the machine `PATH` by
the installer). **Open a fresh terminal** for the PATH change to take
effect (a terminal already open when this ran won't pick it up). Confirm
with:

```bash
k6 version
```

Other OSes / a machine that doesn't have it yet:

- **Windows (alt)**: `choco install k6`
- **macOS**: `brew install k6`
- **Linux**: see https://grafana.com/docs/k6/latest/set-up/install-k6/
- **No install needed**: `docker run --rm -i grafana/k6 run - <script.js`

## Verified working this session

A throwaway script (`k6 run` against `chat-hub-api`'s `GET /health`, 3 VUs
for 5s, written outside the repo and deleted immediately after) confirmed
the installed binary genuinely executes and reaches the API — worth
recording what it found even though it wasn't a real T-11 test case: at
~3,400 req/s from 3 virtual users it immediately tripped the app's global
`ThrottlerGuard` (120 req/min/IP, see `app.module.ts`), so most requests
came back `429` — **expected, not a bug**. It's a preview of the single
biggest thing T-11's real scripts need to design around: either pace
requests to stay under the global throttle, or have `ThrottlerGuard`
allow-list the k6 source IP/a test API key for load-test runs, per
whatever T-11 decides.

## Running a script (once T-11 adds one)

```bash
# from chat-hub-api/, against the test DB / a running dev-mode API instance
k6 run k6/<script>.js
```

Each script should target `http://localhost:3001` (or `$API_BASE_URL`) and
use the seeded test accounts documented in
`../../files/reports/README.md` — never a production URL.

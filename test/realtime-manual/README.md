# T-02 Realtime — manual WebSocket test scripts

Plain Node scripts (not Jest) driving the real `RealtimeGateway` over real
`socket.io-client` connections — one script per T-02 task requirement. Kept
here (rather than under `test/*.e2e-spec.ts`) because several of them need
things Jest's single-process model doesn't fit well: pacing sends across
real wall-clock minutes (rate-limit-aware latency measurement), and staying
alive across an external process kill/restart (the reconnection storm).

**Setup used for every script:**
```bash
npm run seed:test
set -a && source .env.test && set +a && npm run start   # port 3011, zendesk_test
```

**Run each script individually:**
```bash
node test/realtime-manual/test1-latency.js
node test/realtime-manual/test2-reconnect.js
node test/realtime-manual/test3-typing.js
node test/realtime-manual/test4-live-draft.js
node test/realtime-manual/test5-page-changed.js
node test/realtime-manual/test6-profile-updated.js
node test/realtime-manual/test7-proactive.js
node test/realtime-manual/test8-routing.js
node test/realtime-manual/test9-read-receipts.js
node test/realtime-manual/test10-reconnection-storm.js   # needs an external
    # kill+restart of the chat-hub-api process partway through — see the
    # script's own header comment for the READY_FOR_KILL protocol.
```

`helpers.js` is shared plumbing (login, visitor-session init, socket
connect/wait helpers, REST fetch). See `files/reports/T-02-realtime.md` for
full results, findings, and the one documented gateway quirk
(`emitWithAck` doesn't work against this gateway's handlers — see
`helpers.js`'s `emitAndWait`/`emitAndWaitEither` doc comment).

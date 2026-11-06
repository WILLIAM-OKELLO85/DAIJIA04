# SafeRide Daijia — build progress

Fresh build in this folder. The older project in /home/claude/saferide-daijia was NOT used as a base
(some of its files were accidentally overwritten earlier; see chat). Do not copy from it blindly.

Resume rule: read this file first, do the first unchecked item, tick it, and add a line to the log.

## Checklist
- [x] Copy backend files written in session into this folder
- [x] Review backend & fix known issues (see "Fix list")
- [x] Install deps (zod upgrade for audit advisory) + syntax check
- [x] Local Postgres for testing (no docker)
- [x] Unit tests: pricing, tripMachine, utils (node --test)
- [x] Integration smoke test: full trip flow via HTTP (tests/e2e.test.js)
- [x] PWA shared JS (api client, token refresh, socket)
- [x] Client PWA (public/client)
- [x] Driver PWA (public/driver)
- [x] Admin dashboard (public/admin)
- [x] Venue portal (public/venue) + share page (public/share)
- [x] Landing page (public/index.html), manifest + service worker
- [x] README.md for this folder (run instructions, env, API)
- [x] Final end-to-end run and report

## Fix list (found in review)
- [x] seed.sql not idempotent (no unique on zones/venues name)
- [x] arrived(): bypasses proximity check if no GPS fix -> require a fix
- [x] socket location events not throttled
- [x] zod advisory (GHSA-mrhx-c7xc-m3w5): upgrade to zod 4 and re-test
- [x] photo/doc URL token in query string: documented in README limitations

## Log
- 2026-10-25 10:1x  Created folder, copied backend files, wrote this file.
- 10:2x  Fixes applied (unique names, GPS fix required, socket throttle, zod 4). npm audit clean. zod4 behaviour still needs the smoke test to confirm.
- 10:5x  Backend verified: 8 unit tests + 3 e2e tests pass. Bugs found and fixed by tests: pg BIGINT returned as string (broke every id comparison) -> parser in src/db.js; auth rate limit too tight for shared mobile IPs.
         Test DB: Postgres 16 at /home/claude/.pg-saferide-new (port 54329, user saferide, no password, db saferide).
         Start:  runuser -u claude -- /usr/lib/postgresql/16/bin/pg_ctl -D /home/claude/.pg-saferide-new/data -o "-p 54329 -k /home/claude/.pg-saferide-new/run -c listen_addresses=127.0.0.1" -l /home/claude/.pg-saferide-new/pg.log start
         Run tests: TEST_DATABASE_URL=postgres://saferide@127.0.0.1:54329/saferide npm test   (e2e TRUNCATES that DB)
         Next: PWAs. CSP forbids inline <script>/onclick: use external .js files only.
- 11:1x  Shared JS/CSS, client PWA, driver PWA written (syntax-checked only; browser check still to do). Next: admin, venue+share pages, landing, README, browser run-through.
- 14:5x  Resumed after daily-limit gap. Admin dashboard verified present + syntax OK. Fixed npm test script (node --test tests/*.test.js). 11/11 tests pass. Postgres restarted (see 10:5x command). Next: venue portal + share page, landing, README, browser run-through.
- 15:0x  Venue portal (+ /venues/mine, SMS to patron), share page, landing page, client ?venue= QR support written; syntax OK. Next: e2e test for venue+share, README, real-browser run-through (playwright chromium), final report.
- 15:2x  Venue/share e2e test added; 12/12 tests pass. Next: Chromium run-through of every page (CSP/console errors), README, final report.
- 15:5x  Leaflet vendored locally (CDN dependency removed, CSP tightened). Chromium run-through OK: all pages load, client login->venue QR->quote->request works. README + .gitignore written. 12/12 tests, npm audit clean. Remaining: final report only.
- 16:0x  Fixed: duplicate unique-key -> 409 (was 500); e2e now re-runnable. 12/12 tests pass twice in a row. DONE. Dev server stopped; test Postgres still running on :54329.
- 10:5x (2026-10-26)  Resumed. Postgres had stopped (container reset) -> restarted. Ran full ride flow in real Chromium (driver KYC -> admin approve -> offer -> accept -> photos -> start -> end -> M-Pesa mock -> rate -> payout) and found+fixed:
         * BUG: GET /trips/current dropped PAID trips, so the client could never reach the rating screen (+ regression asserts in e2e, + Skip button).
         * BUG: Leaflet "_leaflet_pos" page errors (zoom animation firing on a removed map) -> animations off on all maps, dead-map guard.
         * docker-compose: api now waits for db healthcheck (cold-start migrate crash).
         All pages: 0 console errors. 12/12 tests, npm audit clean. Dev server stopped; test Postgres still on :54329.
         Test scripts used (not in repo): scratchpad flow.py / flow2.py (Playwright). Note e2e TRUNCATEs venues -> run `npm run db:seed` after if you reuse that DB.
- 11:3x (2026-10-27)  Resumed. Browser-tested the screens not yet covered (account/emergency contacts, SOS, cancel, history, no-driver). Found+fixed:
         * BUG: client Cancel button was dead once a driver had accepted (innerHTML += wiped its click handler) -> insertAdjacentHTML.
         * BUG: removing an emergency contact used raw fetch with a possibly-expired token -> api.del (auto-refresh).
         * Driver car-check screen hardcoded '/4 photos' -> now uses configured MIN_PRE_PHOTOS via /drivers/me.minPrePhotos.
         Browser scripts moved into repo: tests/browser/{ride_flow,secondary_screens}.py (both pass, 0 console errors). 12/12 npm tests pass.

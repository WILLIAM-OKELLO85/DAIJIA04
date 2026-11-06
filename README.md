# SafeRide Daijia

On-demand surrogate driving for Kenya: a vetted driver arrives on a foldable e-scooter, drives **your car** home with you in it, and rides away. Pay with M-Pesa.

This repository is a working implementation of the TRS: Node.js + Express + Socket.io API, PostgreSQL, and five dependency-light web apps (no build step).

| App | URL | For |
|---|---|---|
| Landing | `/` | Everyone |
| Client PWA | `/client/` | Patrons requesting a ride (`/client/?venue=CODE` pre-fills the venue as pickup) |
| Driver PWA | `/driver/` | Drivers: KYC, go online, accept, inspect, drive, earn, withdraw |
| Venue portal | `/venue/` | Bar/club staff: request a ride for a patron, referral stats, QR link |
| Admin console | `/admin/` | Ops: KYC review, live map, disputes/refunds, SOS, zones, promos, venues, analytics |
| Share page | `/share/?t=TOKEN` | Trusted contacts watching a trip live (no sign-in) |

## Quick start

Requires Node 20+ and PostgreSQL 14+ (PostGIS optional). Redis is optional (an in-memory location store is used when `REDIS_URL` is empty).

```bash
cp .env.example .env            # edit DATABASE_URL at least
npm install
npm run db:migrate
npm run db:seed                 # service zones, demo venue, promo LAUNCH20
npm run db:demo                 # optional sample accounts and trip records (development only)
npm start                       # http://localhost:4000
```

Or with Docker: `docker compose up --build`.

`npm run db:demo` loads repeatable development data from the ordered SQL files in `db/demo/` after migrations and the reference seed:

- `01_users.sql` — demo accounts and emergency contact
- `02_driver_profiles.sql` — approved and pending driver profiles
- `03_venue_staff.sql` — venue staff association
- `04_trips.sql` — matching, paid, and cancelled trips
- `05_trip_activity.sql` — payment, payout, trip events, SOS, and audit record

The files load together in one transaction. Do not run them in production. The sample dataset intentionally does not create login tokens, OTP codes, or document/photo files.

**Dev conveniences** (all disabled in production): OTP codes are returned in the API response and auto-filled in the apps when no SMS provider is configured; `MPESA_ENV=mock` simulates the STK push and confirms payment after ~2.5 s; the first login of any number in `ADMIN_PHONES` becomes an admin.

### Try the whole flow
1. `/admin/` – sign in with your `ADMIN_PHONES` number.
2. `/driver/` – sign up with another number, upload the three documents; approve it in Admin → Drivers.
3. Driver goes online (the browser shares GPS). `/client/` – sign up, set pickup/drop-off, request.
4. Driver accepts → en route → arrived → uploads pre-trip photos → start → complete. Client pays (mock M-Pesa). Driver withdraws.

## Configuration
See `.env.example`. Important ones: `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, `MPESA_CALLBACK_SECRET` (the app refuses to start in production with default values), `MPESA_ENV` (`mock | sandbox | production`) plus Daraja credentials, `AT_USERNAME`/`AT_API_KEY` (Africa's Talking), fare rules (`BASE_FARE_KES`, `PER_KM_KES`, night surge window/multiplier, `PLATFORM_COMMISSION_PCT`), and dispatch radius/timeouts.

## How it works
- **Trip states:** `MATCHING → ACCEPTED → DRIVER_EN_ROUTE → ARRIVED → IN_PROGRESS → COMPLETED → PAID` (plus cancelled / no-driver / payment-failed / disputed / refunded). Every transition is validated in `src/services/tripMachine.js`, row-locked, and written to the append-only `trip_events` table.
- **Start gate:** a trip cannot start until the minimum pre-trip photos exist; insurance cover is bound at start.
- **Dispatch:** nearest available approved drivers are ranked by distance, rating and idle time, offered the trip in rounds, and the radius widens if nobody accepts.
- **Pricing:** `max(min fare, base + km×rate + wait×rate) × surge − promo`; night surge (23:00–04:00 Nairobi) and zone surge do not stack, the larger wins. Surge is locked at request time.
- **Payments:** M-Pesa STK Push with an idempotent, secret-authenticated callback; driver share credited to a wallet; B2C payouts debit first and refund on failure.
- **Privacy:** photos and KYC documents are served only to the people on the trip (and admins); clients only see anonymised nearby-driver dots.

## API (base `/api/v1`)
Auth: `POST /auth/otp/request`, `/auth/otp/verify`, `/auth/refresh`, `/auth/logout`, `GET/PATCH /auth/me`, `/auth/emergency-contacts`.
Trips: `POST /trips/quote`, `/trips/request`, `GET /trips`, `/trips/current`, `/trips/:id`, `POST /trips/:id/{cancel,rate,accept,decline,en-route,arrived,photos,start,complete}`.
Payments: `POST /payments/mpesa/stk-push`, `/payments/mpesa/callback`. Drivers: `/drivers/me[/documents|upload|online|location|earnings|payouts]`, `GET /drivers/nearby`.
Others: `POST /sos/trigger`, `/venues/*`, `GET /share/:token`, `/admin/*`. Real-time events over Socket.io (JWT in `auth.token`): `trip:offer`, `trip:update`, `driver:location`, `trip:photo`, `sos:alert`.

## Browser regression tests
Two Playwright scripts in `tests/browser/` drive the real apps in Chromium (they caught UI-only bugs the API tests could not):
`ride_flow.py` (driver KYC -> admin approval -> ride -> M-Pesa mock -> rating -> payout) and `secondary_screens.py`
(emergency contacts, SOS, cancel, history, no-driver). Start the app with `MPESA_ENV=mock ADMIN_PHONES=+254700000001`
on a freshly seeded database, `pip install playwright`, then `python3 tests/browser/ride_flow.py`. See each file's header.

## Tests
```bash
npm test                                                   # unit tests (no database needed)
TEST_DATABASE_URL=postgres://user@host:5432/testdb npm test   # + end-to-end flow. WARNING: truncates that database
```

## Known limitations / before launch
- **Dispatch offers live in process memory** – run a single API node, or move offer state to Redis before scaling out.
- **Insurance** (`services/insurance.js`) is a mock; wire in the partner insurer's API.
- **Distance** is a straight-line × 1.3 estimate corrected by GPS tracking; plug in Google Maps/Mapbox for routing and ETAs.
- **Driver KYC** is manual review only; no automated NTSA / Good Conduct verification.
- **Private file URLs** carry the short-lived access token in the query string (needed for `<img>`); keep access-token TTL short and strip query strings from logs.
- **Refunds** are recorded in the app; the M-Pesa reversal itself is still done via Safaricom.
- **Photos** are stored on local disk (`uploads/`); use S3/GCS in production.
- Rate limiting is per-process; put a gateway or Redis limiter in front when scaling.
- Have a licensed insurance advisor and Kenyan counsel review transport licensing, liability and Data Protection Act obligations before launch.

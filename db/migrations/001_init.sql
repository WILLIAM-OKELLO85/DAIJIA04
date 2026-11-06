-- SafeRide Daijia core schema.
-- PostGIS is used when available; lat/lng columns are always kept so the app
-- also runs on plain PostgreSQL.
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS postgis;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'PostGIS not available, continuing without it';
END $$;

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  phone         TEXT UNIQUE NOT NULL,
  name          TEXT,
  role          TEXT NOT NULL DEFAULT 'CLIENT'
                CHECK (role IN ('CLIENT','DRIVER','VENUE','ADMIN')),
  status        TEXT NOT NULL DEFAULT 'ACTIVE'
                CHECK (status IN ('ACTIVE','SUSPENDED')),
  language      TEXT NOT NULL DEFAULT 'en',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id          BIGSERIAL PRIMARY KEY,
  phone       TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS otp_phone_idx ON otp_codes (phone, created_at DESC);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked     BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS driver_profiles (
  user_id             BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  national_id         TEXT,
  license_number      TEXT,
  good_conduct_url    TEXT,
  license_url         TEXT,
  id_url              TEXT,
  vehicle_type        TEXT DEFAULT 'E-SCOOTER',
  verification_status TEXT NOT NULL DEFAULT 'PENDING'
                      CHECK (verification_status IN ('PENDING','APPROVED','REJECTED')),
  rejection_reason    TEXT,
  online              BOOLEAN NOT NULL DEFAULT false,
  rating_avg          NUMERIC(3,2) NOT NULL DEFAULT 5.00,
  rating_count        INT NOT NULL DEFAULT 0,
  trips_completed     INT NOT NULL DEFAULT 0,
  last_trip_end       TIMESTAMPTZ,
  wallet_balance_kes  NUMERIC(12,2) NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS venues (
  id             BIGSERIAL PRIMARY KEY,
  name           TEXT NOT NULL UNIQUE,
  lat            DOUBLE PRECISION NOT NULL,
  lng            DOUBLE PRECISION NOT NULL,
  contact_person TEXT,
  referral_code  TEXT UNIQUE NOT NULL,
  referral_bonus_kes NUMERIC(10,2) NOT NULL DEFAULT 50,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS venue_staff (
  user_id   BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  venue_id  BIGINT NOT NULL REFERENCES venues(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS service_zones (
  id          BIGSERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  center_lat  DOUBLE PRECISION NOT NULL,
  center_lng  DOUBLE PRECISION NOT NULL,
  radius_km   DOUBLE PRECISION NOT NULL,
  surge_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  active      BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS promo_codes (
  code          TEXT PRIMARY KEY,
  percent_off   INT NOT NULL DEFAULT 0,
  flat_off_kes  INT NOT NULL DEFAULT 0,
  max_uses      INT,
  used_count    INT NOT NULL DEFAULT 0,
  expires_at    TIMESTAMPTZ,
  active        BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS trips (
  id              BIGSERIAL PRIMARY KEY,
  client_id       BIGINT NOT NULL REFERENCES users(id),
  driver_id       BIGINT REFERENCES users(id),
  venue_id        BIGINT REFERENCES venues(id),
  status          TEXT NOT NULL DEFAULT 'REQUESTED',
  pickup_lat      DOUBLE PRECISION NOT NULL,
  pickup_lng      DOUBLE PRECISION NOT NULL,
  pickup_address  TEXT,
  dropoff_lat     DOUBLE PRECISION NOT NULL,
  dropoff_lng     DOUBLE PRECISION NOT NULL,
  dropoff_address TEXT,
  est_distance_km NUMERIC(8,2) NOT NULL,
  est_fare_kes    NUMERIC(10,2) NOT NULL,
  surge_multiplier NUMERIC(4,2) NOT NULL DEFAULT 1.0,
  promo_code      TEXT,
  discount_kes    NUMERIC(10,2) NOT NULL DEFAULT 0,
  actual_distance_km NUMERIC(8,2),
  wait_minutes    NUMERIC(6,1) NOT NULL DEFAULT 0,
  final_fare_kes  NUMERIC(10,2),
  commission_kes  NUMERIC(10,2),
  driver_earning_kes NUMERIC(10,2),
  insurance_ref   TEXT,
  client_rating   INT CHECK (client_rating BETWEEN 1 AND 5),
  client_feedback TEXT,
  cancel_reason   TEXT,
  cancel_fee_kes  NUMERIC(10,2) NOT NULL DEFAULT 0,
  share_token     TEXT UNIQUE,
  requested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_at     TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS trips_client_idx ON trips (client_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS trips_driver_idx ON trips (driver_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS trips_status_idx ON trips (status);

-- Append-only audit trail of every state change and location sample.
CREATE TABLE IF NOT EXISTS trip_events (
  id         BIGSERIAL PRIMARY KEY,
  trip_id    BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  actor_id   BIGINT,
  payload    JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS trip_events_trip_idx ON trip_events (trip_id, id);

CREATE TABLE IF NOT EXISTS trip_photos (
  id         BIGSERIAL PRIMARY KEY,
  trip_id    BIGINT NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  phase      TEXT NOT NULL CHECK (phase IN ('PRE','POST')),
  photo_url  TEXT NOT NULL,
  lat        DOUBLE PRECISION,
  lng        DOUBLE PRECISION,
  taken_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payments (
  id              BIGSERIAL PRIMARY KEY,
  trip_id         BIGINT NOT NULL REFERENCES trips(id),
  method          TEXT NOT NULL DEFAULT 'MPESA',
  amount_kes      NUMERIC(10,2) NOT NULL,
  phone           TEXT,
  checkout_request_id TEXT UNIQUE,
  merchant_request_id TEXT,
  mpesa_receipt   TEXT UNIQUE,
  status          TEXT NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','SUCCESS','FAILED','CANCELLED')),
  failure_reason  TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS payouts (
  id          BIGSERIAL PRIMARY KEY,
  driver_id   BIGINT NOT NULL REFERENCES users(id),
  amount_kes  NUMERIC(10,2) NOT NULL,
  status      TEXT NOT NULL DEFAULT 'PENDING'
              CHECK (status IN ('PENDING','SUCCESS','FAILED')),
  reference   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS emergency_contacts (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contact_name  TEXT NOT NULL,
  contact_phone TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sos_alerts (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id),
  trip_id      BIGINT REFERENCES trips(id),
  lat          DOUBLE PRECISION,
  lng          DOUBLE PRECISION,
  status       TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_log (
  id         BIGSERIAL PRIMARY KEY,
  actor_id   BIGINT,
  action     TEXT NOT NULL,
  target     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

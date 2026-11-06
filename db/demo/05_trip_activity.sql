-- Payment record for the paid demo trip.
INSERT INTO payments (
  trip_id, method, amount_kes, phone, checkout_request_id, merchant_request_id,
  mpesa_receipt, status, created_at, updated_at
)
SELECT t.id, 'MPESA', 740.00, '+254700000096', 'DEMO-CHECKOUT-PAID-0001',
       'DEMO-MERCHANT-0001', 'DEMO-RECEIPT-0001', 'SUCCESS',
       now() - interval '60 minutes', now() - interval '59 minutes'
FROM trips t
WHERE t.share_token = 'demo-trip-paid-0001'
ON CONFLICT (checkout_request_id) DO UPDATE SET
  trip_id = EXCLUDED.trip_id,
  amount_kes = EXCLUDED.amount_kes,
  phone = EXCLUDED.phone,
  merchant_request_id = EXCLUDED.merchant_request_id,
  mpesa_receipt = EXCLUDED.mpesa_receipt,
  status = EXCLUDED.status,
  updated_at = EXCLUDED.updated_at;

INSERT INTO payouts (driver_id, amount_kes, status, reference, created_at)
SELECT u.id, 300.00, 'SUCCESS', 'DEMO-PAYOUT-0001', now() - interval '30 minutes'
FROM users u
WHERE u.phone = '+254700000093'
  AND NOT EXISTS (SELECT 1 FROM payouts p WHERE p.reference = 'DEMO-PAYOUT-0001');

-- Add stable demo keys so this event history is safe to load repeatedly.
WITH demo_events AS (
  SELECT t.id AS trip_id, 'REQUESTED' AS type, t.client_id AS actor_id,
         t.requested_at AS created_at, 'matching-requested' AS demo_key
  FROM trips t WHERE t.share_token = 'demo-trip-matching-0001'
  UNION ALL
  SELECT t.id, e.type, e.actor_id, e.created_at, e.demo_key
  FROM trips t
  CROSS JOIN LATERAL (VALUES
    ('REQUESTED', t.client_id, t.requested_at, 'paid-requested'),
    ('ACCEPTED', t.driver_id, t.accepted_at, 'paid-accepted'),
    ('DRIVER_EN_ROUTE', t.driver_id, t.accepted_at + interval '2 minutes', 'paid-en-route'),
    ('ARRIVED', t.driver_id, t.accepted_at + interval '10 minutes', 'paid-arrived'),
    ('IN_PROGRESS', t.driver_id, t.started_at, 'paid-started'),
    ('COMPLETED', t.driver_id, t.ended_at - interval '1 minute', 'paid-completed'),
    ('PAID', t.client_id, t.ended_at, 'paid-settled')
  ) AS e(type, actor_id, created_at, demo_key)
  WHERE t.share_token = 'demo-trip-paid-0001'
  UNION ALL
  SELECT t.id, 'CANCELLED_BY_CLIENT', t.client_id, t.ended_at, 'cancelled-by-client'
  FROM trips t WHERE t.share_token = 'demo-trip-cancelled-0001'
)
INSERT INTO trip_events (trip_id, type, actor_id, payload, created_at)
SELECT e.trip_id, e.type, e.actor_id, jsonb_build_object('demo_key', e.demo_key), e.created_at
FROM demo_events e
WHERE e.created_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM trip_events existing
    WHERE existing.trip_id = e.trip_id
      AND existing.payload->>'demo_key' = e.demo_key
  );

INSERT INTO sos_alerts (user_id, trip_id, lat, lng, status)
SELECT client.id, t.id, -1.2650, 36.8040, 'OPEN'
FROM users client
JOIN trips t ON t.share_token = 'demo-trip-matching-0001'
WHERE client.phone = '+254700000092'
  AND NOT EXISTS (
    SELECT 1 FROM sos_alerts s
    WHERE s.user_id = client.id AND s.trip_id = t.id
  );

INSERT INTO audit_log (actor_id, action, target)
SELECT u.id, 'DEMO_DATASET_LOADED', 'db/demo'
FROM users u
WHERE u.phone = '+254700000091'
  AND NOT EXISTS (
    SELECT 1 FROM audit_log a
    WHERE a.action = 'DEMO_DATASET_LOADED' AND a.target = 'db/demo' AND a.actor_id = u.id
  );

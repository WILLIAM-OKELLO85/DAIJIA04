-- A matching trip for the live operations view.
INSERT INTO trips (
  client_id, driver_id, venue_id, status,
  pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address,
  est_distance_km, est_fare_kes, surge_multiplier, promo_code, discount_kes,
  actual_distance_km, wait_minutes, final_fare_kes, commission_kes, driver_earning_kes,
  insurance_ref, client_rating, client_feedback, cancel_reason, cancel_fee_kes,
  share_token, requested_at, accepted_at, started_at, ended_at
)
SELECT client.id, NULL, venue.id, 'MATCHING',
       -1.2650, 36.8040, 'Demo Lounge Westlands', -1.3190, 36.7070, 'Karen, Nairobi',
       14.20, 840.00, 1.00, 'LAUNCH20', 210.00,
       NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0,
       'demo-trip-matching-0001', now() - interval '15 minutes', NULL, NULL, NULL
FROM users client
CROSS JOIN venues venue
WHERE client.phone = '+254700000092'
  AND venue.referral_code = 'DEMOLOUNGE'
ON CONFLICT (share_token) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  driver_id = EXCLUDED.driver_id,
  venue_id = EXCLUDED.venue_id,
  status = EXCLUDED.status,
  pickup_lat = EXCLUDED.pickup_lat,
  pickup_lng = EXCLUDED.pickup_lng,
  pickup_address = EXCLUDED.pickup_address,
  dropoff_lat = EXCLUDED.dropoff_lat,
  dropoff_lng = EXCLUDED.dropoff_lng,
  dropoff_address = EXCLUDED.dropoff_address,
  est_distance_km = EXCLUDED.est_distance_km,
  est_fare_kes = EXCLUDED.est_fare_kes,
  surge_multiplier = EXCLUDED.surge_multiplier,
  promo_code = EXCLUDED.promo_code,
  discount_kes = EXCLUDED.discount_kes,
  actual_distance_km = EXCLUDED.actual_distance_km,
  wait_minutes = EXCLUDED.wait_minutes,
  final_fare_kes = EXCLUDED.final_fare_kes,
  commission_kes = EXCLUDED.commission_kes,
  driver_earning_kes = EXCLUDED.driver_earning_kes,
  insurance_ref = EXCLUDED.insurance_ref,
  client_rating = EXCLUDED.client_rating,
  client_feedback = EXCLUDED.client_feedback,
  cancel_reason = EXCLUDED.cancel_reason,
  cancel_fee_kes = EXCLUDED.cancel_fee_kes,
  requested_at = EXCLUDED.requested_at,
  accepted_at = EXCLUDED.accepted_at,
  started_at = EXCLUDED.started_at,
  ended_at = EXCLUDED.ended_at;

-- A completed and paid trip for payments, earnings, and analytics views.
INSERT INTO trips (
  client_id, driver_id, venue_id, status,
  pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address,
  est_distance_km, est_fare_kes, surge_multiplier, promo_code, discount_kes,
  actual_distance_km, wait_minutes, final_fare_kes, commission_kes, driver_earning_kes,
  insurance_ref, client_rating, client_feedback, cancel_reason, cancel_fee_kes,
  share_token, requested_at, accepted_at, started_at, ended_at
)
SELECT client.id, driver.id, venue.id, 'PAID',
       -1.2650, 36.8040, 'Demo Lounge Westlands', -1.2900, 36.7850, 'Kilimani, Nairobi',
       8.50, 740.00, 1.00, NULL, 0,
       8.70, 2.0, 740.00, 148.00, 592.00,
       'DEMO-INSURANCE-0001', 5, 'Demo rating', NULL, 0,
       'demo-trip-paid-0001', now() - interval '2 hours', now() - interval '110 minutes',
       now() - interval '90 minutes', now() - interval '60 minutes'
FROM users client
CROSS JOIN users driver
CROSS JOIN venues venue
WHERE client.phone = '+254700000096'
  AND driver.phone = '+254700000093'
  AND venue.referral_code = 'DEMOLOUNGE'
ON CONFLICT (share_token) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  driver_id = EXCLUDED.driver_id,
  venue_id = EXCLUDED.venue_id,
  status = EXCLUDED.status,
  pickup_lat = EXCLUDED.pickup_lat,
  pickup_lng = EXCLUDED.pickup_lng,
  pickup_address = EXCLUDED.pickup_address,
  dropoff_lat = EXCLUDED.dropoff_lat,
  dropoff_lng = EXCLUDED.dropoff_lng,
  dropoff_address = EXCLUDED.dropoff_address,
  est_distance_km = EXCLUDED.est_distance_km,
  est_fare_kes = EXCLUDED.est_fare_kes,
  surge_multiplier = EXCLUDED.surge_multiplier,
  promo_code = EXCLUDED.promo_code,
  discount_kes = EXCLUDED.discount_kes,
  actual_distance_km = EXCLUDED.actual_distance_km,
  wait_minutes = EXCLUDED.wait_minutes,
  final_fare_kes = EXCLUDED.final_fare_kes,
  commission_kes = EXCLUDED.commission_kes,
  driver_earning_kes = EXCLUDED.driver_earning_kes,
  insurance_ref = EXCLUDED.insurance_ref,
  client_rating = EXCLUDED.client_rating,
  client_feedback = EXCLUDED.client_feedback,
  cancel_reason = EXCLUDED.cancel_reason,
  cancel_fee_kes = EXCLUDED.cancel_fee_kes,
  requested_at = EXCLUDED.requested_at,
  accepted_at = EXCLUDED.accepted_at,
  started_at = EXCLUDED.started_at,
  ended_at = EXCLUDED.ended_at;

-- A cancelled trip for trip-history and cancellation views.
INSERT INTO trips (
  client_id, driver_id, venue_id, status,
  pickup_lat, pickup_lng, pickup_address, dropoff_lat, dropoff_lng, dropoff_address,
  est_distance_km, est_fare_kes, surge_multiplier, promo_code, discount_kes,
  actual_distance_km, wait_minutes, final_fare_kes, commission_kes, driver_earning_kes,
  insurance_ref, client_rating, client_feedback, cancel_reason, cancel_fee_kes,
  share_token, requested_at, accepted_at, started_at, ended_at
)
SELECT client.id, NULL, venue.id, 'CANCELLED_BY_CLIENT',
       -1.2900, 36.7850, 'Kilimani, Nairobi', -1.2800, 36.7700, 'Lavington, Nairobi',
       4.10, 500.00, 1.00, NULL, 0,
       NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, 'Demo cancellation', 0,
       'demo-trip-cancelled-0001', now() - interval '1 day', NULL, NULL, now() - interval '23 hours'
FROM users client
CROSS JOIN venues venue
WHERE client.phone = '+254700000092'
  AND venue.referral_code = 'DEMOLOUNGE'
ON CONFLICT (share_token) DO UPDATE SET
  client_id = EXCLUDED.client_id,
  driver_id = EXCLUDED.driver_id,
  venue_id = EXCLUDED.venue_id,
  status = EXCLUDED.status,
  pickup_lat = EXCLUDED.pickup_lat,
  pickup_lng = EXCLUDED.pickup_lng,
  pickup_address = EXCLUDED.pickup_address,
  dropoff_lat = EXCLUDED.dropoff_lat,
  dropoff_lng = EXCLUDED.dropoff_lng,
  dropoff_address = EXCLUDED.dropoff_address,
  est_distance_km = EXCLUDED.est_distance_km,
  est_fare_kes = EXCLUDED.est_fare_kes,
  surge_multiplier = EXCLUDED.surge_multiplier,
  promo_code = EXCLUDED.promo_code,
  discount_kes = EXCLUDED.discount_kes,
  actual_distance_km = EXCLUDED.actual_distance_km,
  wait_minutes = EXCLUDED.wait_minutes,
  final_fare_kes = EXCLUDED.final_fare_kes,
  commission_kes = EXCLUDED.commission_kes,
  driver_earning_kes = EXCLUDED.driver_earning_kes,
  insurance_ref = EXCLUDED.insurance_ref,
  client_rating = EXCLUDED.client_rating,
  client_feedback = EXCLUDED.client_feedback,
  cancel_reason = EXCLUDED.cancel_reason,
  cancel_fee_kes = EXCLUDED.cancel_fee_kes,
  requested_at = EXCLUDED.requested_at,
  accepted_at = EXCLUDED.accepted_at,
  started_at = EXCLUDED.started_at,
  ended_at = EXCLUDED.ended_at;

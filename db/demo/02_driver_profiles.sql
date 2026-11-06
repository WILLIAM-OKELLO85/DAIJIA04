-- One approved driver profile and one profile awaiting KYC review.
INSERT INTO driver_profiles (
  user_id, national_id, license_number, vehicle_type, verification_status,
  online, rating_avg, rating_count, trips_completed, wallet_balance_kes
)
SELECT u.id, d.national_id, d.license_number, 'E-SCOOTER', d.verification_status,
       false, d.rating_avg, d.rating_count, d.trips_completed, d.wallet_balance_kes
FROM (VALUES
  ('+254700000093', 'DEMO-ID-0001', 'DEMO-DL-0001', 'APPROVED', 4.90::numeric, 12, 24, 1250.00::numeric),
  ('+254700000094', NULL, NULL, 'PENDING', 5.00::numeric, 0, 0, 0.00::numeric)
) AS d(phone, national_id, license_number, verification_status, rating_avg, rating_count, trips_completed, wallet_balance_kes)
JOIN users u ON u.phone = d.phone
ON CONFLICT (user_id) DO UPDATE SET
  national_id = EXCLUDED.national_id,
  license_number = EXCLUDED.license_number,
  vehicle_type = EXCLUDED.vehicle_type,
  verification_status = EXCLUDED.verification_status,
  online = false,
  rating_avg = EXCLUDED.rating_avg,
  rating_count = EXCLUDED.rating_count,
  trips_completed = EXCLUDED.trips_completed,
  wallet_balance_kes = EXCLUDED.wallet_balance_kes;

-- Link the demo venue staff account to the seeded Westlands venue.
INSERT INTO venue_staff (user_id, venue_id)
SELECT u.id, v.id
FROM users u
CROSS JOIN venues v
WHERE u.phone = '+254700000095'
  AND v.referral_code = 'DEMOLOUNGE'
ON CONFLICT (user_id) DO UPDATE SET venue_id = EXCLUDED.venue_id;

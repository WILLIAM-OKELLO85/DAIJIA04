INSERT INTO service_zones (name, center_lat, center_lng, radius_km) VALUES
 ('Westlands', -1.2673, 36.8113, 4),
 ('Kilimani',  -1.2900, 36.7850, 4),
 ('Lavington', -1.2800, 36.7700, 4),
 ('Karen',     -1.3190, 36.7070, 6)
ON CONFLICT DO NOTHING;

INSERT INTO venues (name, lat, lng, contact_person, referral_code) VALUES
 ('Demo Lounge Westlands', -1.2650, 36.8040, 'Demo Manager', 'DEMOLOUNGE')
ON CONFLICT DO NOTHING;

INSERT INTO promo_codes (code, percent_off, flat_off_kes, max_uses) VALUES
 ('LAUNCH20', 20, 0, 1000)
ON CONFLICT DO NOTHING;

-- Demo accounts and their emergency-contact record.
INSERT INTO users (phone, name, role, status) VALUES
  ('+254700000091', 'Demo Admin', 'ADMIN', 'ACTIVE'),
  ('+254700000092', 'Demo Client', 'CLIENT', 'ACTIVE'),
  ('+254700000093', 'Demo Driver', 'DRIVER', 'ACTIVE'),
  ('+254700000094', 'Pending Demo Driver', 'DRIVER', 'ACTIVE'),
  ('+254700000095', 'Demo Venue Staff', 'VENUE', 'ACTIVE'),
  ('+254700000096', 'Second Demo Client', 'CLIENT', 'ACTIVE')
ON CONFLICT (phone) DO UPDATE SET
  name = EXCLUDED.name,
  role = EXCLUDED.role,
  status = EXCLUDED.status;

INSERT INTO emergency_contacts (user_id, contact_name, contact_phone)
SELECT u.id, 'Demo Emergency Contact', '+254700000097'
FROM users u
WHERE u.phone = '+254700000092'
  AND NOT EXISTS (
    SELECT 1 FROM emergency_contacts c
    WHERE c.user_id = u.id AND c.contact_phone = '+254700000097'
  );

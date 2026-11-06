const router = require('express').Router();
const { z } = require('zod');
const trips = require('../services/tripService');
const { authenticate, requireRole } = require('../middleware/auth');
const { wrap } = require('../utils');

router.use(authenticate);

const point = z.object({
  lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), address: z.string().max(200).optional(),
});
const reqBody = z.object({ pickup: point, dropoff: point, promoCode: z.string().max(30).optional() });
const id = (req) => z.coerce.number().int().positive().parse(req.params.id);

// ---- client ----
router.post('/quote', requireRole('CLIENT', 'ADMIN'), wrap(async (req, res) => {
  res.json(await trips.quote(reqBody.parse(req.body)));
}));
router.post('/request', requireRole('CLIENT'), wrap(async (req, res) => {
  res.status(201).json(await trips.createTrip(req.user.id, reqBody.parse(req.body)));
}));
router.post('/:id/rate', requireRole('CLIENT'), wrap(async (req, res) => {
  const b = z.object({ rating: z.number().int().min(1).max(5), feedback: z.string().max(500).optional() }).parse(req.body);
  await trips.rate(req.user.id, id(req), b);
  res.json({ ok: true });
}));

// ---- both ----
router.get('/', wrap(async (req, res) => res.json(await trips.listForUser(req.user))));
router.get('/current', wrap(async (req, res) => res.json(await trips.currentForUser(req.user)))); // null when none
router.get('/:id', wrap(async (req, res) => res.json(await trips.getForUser(req.user, id(req)))));
router.post('/:id/cancel', requireRole('CLIENT', 'DRIVER', 'ADMIN'), wrap(async (req, res) => {
  const { reason } = z.object({ reason: z.string().max(200).optional() }).parse(req.body || {});
  res.json(await trips.cancel(req.user, id(req), reason));
}));

// ---- driver ----
const driver = requireRole('DRIVER');
router.post('/:id/accept', driver, wrap(async (req, res) => res.json(await trips.accept(req.user.id, id(req)))));
router.post('/:id/decline', driver, wrap(async (req, res) => { trips.declineOffer(req.user.id, id(req)); res.json({ ok: true }); }));
router.post('/:id/en-route', driver, wrap(async (req, res) => res.json(await trips.enRoute(req.user.id, id(req)))));
router.post('/:id/arrived', driver, wrap(async (req, res) => res.json(await trips.arrived(req.user.id, id(req)))));
router.post('/:id/photos', driver, wrap(async (req, res) => {
  const b = z.object({ phase: z.enum(['PRE', 'POST']), image: z.string() }).parse(req.body);
  res.status(201).json(await trips.addPhoto(req.user.id, id(req), b));
}));
router.post('/:id/start', driver, wrap(async (req, res) => res.json(await trips.start(req.user.id, id(req)))));
router.post('/:id/complete', driver, wrap(async (req, res) => res.json(await trips.complete(req.user.id, id(req)))));

module.exports = router;

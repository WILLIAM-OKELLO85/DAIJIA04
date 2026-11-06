// Public, read-only live trip view for the client's trusted contacts.
const router = require('express').Router();
const trips = require('../services/tripService');
const { rateLimit } = require('../middleware/rateLimit');
const { wrap } = require('../utils');

router.get('/:token', rateLimit({ windowMs: 60_000, max: 60 }), wrap(async (req, res) => {
  if (!/^[a-f0-9]{32}$/.test(req.params.token)) return res.status(404).json({ error: 'Link not found' });
  res.json(await trips.shareView(req.params.token));
}));

module.exports = router;

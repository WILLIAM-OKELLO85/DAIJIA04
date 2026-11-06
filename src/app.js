const express = require('express');
const helmet = require('helmet');
const path = require('path');
const { ZodError } = require('zod');
const config = require('./config');
const { HttpError } = require('./utils');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:', 'blob:', 'https://tile.openstreetmap.org', 'https://*.tile.openstreetmap.org'],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      workerSrc: ["'self'"],
      manifestSrc: ["'self'"],
    },
  },
}));
app.use(express.json({ limit: '10mb' })); // photos are base64 data URLs

app.get('/healthz', (_req, res) => res.json({ ok: true, env: config.env }));

const api = express.Router();
api.use('/auth', require('./routes/auth'));
api.use('/trips', require('./routes/trips'));
api.use('/drivers', require('./routes/drivers'));
api.use('/payments', require('./routes/payments'));
api.use('/sos', require('./routes/sos'));
api.use('/venues', require('./routes/venues'));
api.use('/admin', require('./routes/admin'));
api.use('/share', require('./routes/share'));
api.use((_req, _res, next) => next(new HttpError(404, 'Not found', 'NOT_FOUND')));
app.use('/api/v1', api);

app.use('/uploads', require('./routes/uploads'));

// PWAs: /client, /driver, /admin, /share, and the landing page at /
const pub = path.join(__dirname, '..', 'public');
app.use(express.static(pub, { extensions: ['html'] }));

app.use((err, req, res, _next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; '), code: 'VALIDATION' });
  }
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
  if (err.code === '23505') return res.status(409).json({ error: 'That already exists', code: 'DUPLICATE' }); // Postgres unique violation
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Payload too large', code: 'TOO_LARGE' });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON', code: 'BAD_JSON' });
  console.error('[error]', req.method, req.url, err);
  res.status(500).json({ error: 'Internal server error', code: 'INTERNAL' });
});

module.exports = app;

const http = require('http');
const config = require('./config');
const app = require('./app');
const rt = require('./realtime');
const loc = require('./services/locationService');
const dispatch = require('./services/dispatch');

if (config.isProd && (config.jwt.accessSecret.startsWith('dev-') || config.jwt.refreshSecret.startsWith('dev-')
    || config.mpesa.callbackSecret.startsWith('dev-'))) {
  console.error('Refusing to start in production with default secrets. Set JWT_*_SECRET and MPESA_CALLBACK_SECRET.');
  process.exit(1);
}

const server = http.createServer(app);
rt.init(server, { onDriverLocation: loc.onDriverLocation });

server.listen(config.port, async () => {
  console.log(`SafeRide API listening on :${config.port} (${config.env}, mpesa=${config.mpesa.env}, locations=${config.redisUrl ? 'redis' : 'memory'})`);
  try {
    await loc.rehydrate();
    await dispatch.resumeUnmatched();
  } catch (e) {
    console.error('[startup] could not rehydrate state (is the database migrated?):', e.message);
  }
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

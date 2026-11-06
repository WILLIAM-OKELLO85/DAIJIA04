require('dotenv').config();

const num = (k, d) => (process.env[k] !== undefined && process.env[k] !== '' ? Number(process.env[k]) : d);
const str = (k, d = '') => process.env[k] ?? d;

const config = {
  env: str('NODE_ENV', 'development'),
  isProd: str('NODE_ENV') === 'production',
  port: num('PORT', 4000),
  jwt: {
    accessSecret: str('JWT_ACCESS_SECRET', 'dev-access-secret'),
    refreshSecret: str('JWT_REFRESH_SECRET', 'dev-refresh-secret'),
    accessTtl: '15m',
    refreshTtlDays: 30,
  },
  databaseUrl: str('DATABASE_URL', 'postgres://saferide:saferide@localhost:5432/saferide'),
  redisUrl: str('REDIS_URL', ''),
  mpesa: {
    env: str('MPESA_ENV', 'mock'), // mock | sandbox | production
    consumerKey: str('MPESA_CONSUMER_KEY'),
    consumerSecret: str('MPESA_CONSUMER_SECRET'),
    shortcode: str('MPESA_SHORTCODE', '174379'),
    passkey: str('MPESA_PASSKEY'),
    callbackUrl: str('MPESA_CALLBACK_URL'),
    callbackSecret: str('MPESA_CALLBACK_SECRET', 'dev-callback-secret'),
    b2cInitiator: str('MPESA_B2C_INITIATOR'),
    b2cCredential: str('MPESA_B2C_SECURITY_CREDENTIAL'),
  },
  sms: {
    username: str('AT_USERNAME'),
    apiKey: str('AT_API_KEY'),
    senderId: str('AT_SENDER_ID'),
  },
  dispatch: {
    initialRadiusKm: num('DISPATCH_INITIAL_RADIUS_KM', 3),
    maxRadiusKm: num('DISPATCH_MAX_RADIUS_KM', 8),
    acceptTimeoutSec: num('DRIVER_ACCEPT_TIMEOUT_SEC', 20),
    offersPerRound: 3,
  },
  pricing: {
    baseFare: num('BASE_FARE_KES', 300),
    perKm: num('PER_KM_KES', 40),
    perMinWait: num('PER_MIN_WAIT_KES', 5),
    minFare: num('MIN_FARE_KES', 500),
    surgeStart: str('NIGHT_SURGE_START', '23:00'),
    surgeEnd: str('NIGHT_SURGE_END', '04:00'),
    surgeMultiplier: num('NIGHT_SURGE_MULTIPLIER', 1.5),
    commissionPct: num('PLATFORM_COMMISSION_PCT', 20),
    cancelGraceSec: num('CANCEL_GRACE_SEC', 120),
    cancelFee: num('CANCEL_FEE_KES', 100),
    roadFactor: 1.3, // straight-line -> road distance estimate
    timezoneOffsetMin: 180, // Africa/Nairobi, UTC+3, no DST
  },
  trip: { minPrePhotos: num('MIN_PRE_PHOTOS', 4) },
  adminPhones: str('ADMIN_PHONES').split(',').map((s) => s.trim()).filter(Boolean),
};

module.exports = config;

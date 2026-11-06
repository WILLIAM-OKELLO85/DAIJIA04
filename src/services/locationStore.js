// Live driver locations. Redis GEO when REDIS_URL is set, in-memory otherwise.
const config = require('../config');
const { haversineKm } = require('../utils');

const TTL_MS = 60 * 1000; // a driver is considered offline if no ping for 60s
const KEY = 'drivers:geo';

class MemoryStore {
  constructor() { this.m = new Map(); }
  async set(id, lat, lng) { this.m.set(String(id), { lat, lng, at: Date.now() }); }
  async get(id) {
    const v = this.m.get(String(id));
    return v && Date.now() - v.at < TTL_MS ? v : null;
  }
  async remove(id) { this.m.delete(String(id)); }
  async nearby(lat, lng, radiusKm) {
    const out = [];
    for (const [id, v] of this.m) {
      if (Date.now() - v.at >= TTL_MS) { this.m.delete(id); continue; }
      const d = haversineKm(lat, lng, v.lat, v.lng);
      if (d <= radiusKm) out.push({ id, lat: v.lat, lng: v.lng, distanceKm: d });
    }
    return out.sort((a, b) => a.distanceKm - b.distanceKm);
  }
  async all() {
    return [...this.m].filter(([, v]) => Date.now() - v.at < TTL_MS).map(([id, v]) => ({ id, lat: v.lat, lng: v.lng }));
  }
}

class RedisStore {
  constructor(url) {
    const Redis = require('ioredis');
    this.r = new Redis(url, { maxRetriesPerRequest: 2 });
    this.r.on('error', (e) => console.error('[redis]', e.message));
  }
  async set(id, lat, lng) {
    await this.r.geoadd(KEY, lng, lat, String(id));
    await this.r.set(`drivers:ping:${id}`, Date.now(), 'PX', TTL_MS);
  }
  async get(id) {
    const alive = await this.r.exists(`drivers:ping:${id}`);
    if (!alive) return null;
    const pos = await this.r.geopos(KEY, String(id));
    return pos && pos[0] ? { lng: Number(pos[0][0]), lat: Number(pos[0][1]) } : null;
  }
  async remove(id) { await this.r.zrem(KEY, String(id)); await this.r.del(`drivers:ping:${id}`); }
  async nearby(lat, lng, radiusKm) {
    const res = await this.r.geosearch(KEY, 'FROMLONLAT', lng, lat, 'BYRADIUS', radiusKm, 'km', 'ASC', 'WITHCOORD', 'WITHDIST');
    const out = [];
    for (const [id, dist, [glng, glat]] of res) {
      if (await this.r.exists(`drivers:ping:${id}`)) out.push({ id, lat: Number(glat), lng: Number(glng), distanceKm: Number(dist) });
      else await this.r.zrem(KEY, id);
    }
    return out;
  }
  async all() {
    const ids = await this.r.zrange(KEY, 0, -1);
    const out = [];
    for (const id of ids) { const p = await this.get(id); if (p) out.push({ id, ...p }); }
    return out;
  }
}

module.exports = config.redisUrl ? new RedisStore(config.redisUrl) : new MemoryStore();

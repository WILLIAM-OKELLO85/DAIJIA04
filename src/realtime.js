// Socket.io layer: JWT-authenticated, one room per user plus an 'admins' room.
const { Server } = require('socket.io');
const { verifyAccess } = require('./middleware/auth');

let io = null;
const handlers = {}; // injected to avoid circular imports: { onDriverLocation }

function init(httpServer, injected) {
  Object.assign(handlers, injected);
  io = new Server(httpServer, { cors: { origin: true } });

  io.use((socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      const p = verifyAccess(token);
      socket.user = { id: Number(p.sub), role: p.role };
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const { id, role } = socket.user;
    socket.join(`user:${id}`);
    if (role === 'ADMIN') socket.join('admins');

    let lastPing = 0;
    socket.on('driver:location', async (msg) => {
      if (role !== 'DRIVER') return;
      const now = Date.now();
      if (now - lastPing < 900) return; // flood protection
      lastPing = now;
      const lat = Number(msg?.lat), lng = Number(msg?.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return;
      try { await handlers.onDriverLocation?.(id, lat, lng); } catch (e) { console.error('[ws] location', e.message); }
    });
  });
  return io;
}

const toUser = (userId, event, data) => io?.to(`user:${userId}`).emit(event, data);
const toAdmins = (event, data) => io?.to('admins').emit(event, data);

module.exports = { init, toUser, toAdmins };

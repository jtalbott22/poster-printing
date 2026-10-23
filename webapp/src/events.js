'use strict';
/**
 * Socket.IO fan-out. Three room families:
 *   user:<id>      every job that person owns
 *   job:<publicId> anyone watching one job (owner or staff)
 *   admin          the operations console
 *   printer:<code> live spooler state for one device
 */
let io = null;

function attach(server, { authenticateSocket }) {
  const { Server } = require('socket.io');
  const config = require('./config');
  // Socket.IO's `path` governs both the handshake/polling endpoint AND
  // where it serves its own client bundle (path + '/socket.io.js'). The two
  // HTML pages load that script from the same prefix — see %%BASE_PATH%% in
  // their <script src>. Empty basePath (the normal root deployment) leaves
  // this at the library's own default.
  io = new Server(server, {
    path: `${config.basePath}/socket.io`,
    serveClient: true,
    cors: { origin: false },
    pingInterval: 25000,
    pingTimeout: 20000,
  });

  io.use((socket, next) => {
    const user = authenticateSocket(socket.request.headers.cookie);
    if (!user) return next(new Error('unauthorized'));
    socket.data.user = user;
    next();
  });

  io.on('connection', (socket) => {
    const u = socket.data.user;
    socket.join(`user:${u.id}`);
    if (['operator', 'admin', 'approver'].includes(u.role)) socket.join('admin');

    socket.on('watch:job', (publicId) => {
      if (typeof publicId === 'string' && /^[A-Za-z0-9-]{1,32}$/.test(publicId)) {
        socket.join(`job:${publicId}`);
      }
    });
    socket.on('unwatch:job', (publicId) => socket.leave(`job:${publicId}`));
    socket.on('watch:printer', (code) => {
      if (['operator', 'admin'].includes(u.role) && /^[a-z0-9-]{1,40}$/.test(code || '')) {
        socket.join(`printer:${code}`);
      }
    });
  });

  return io;
}

const emit = (room, event, payload) => { if (io) io.to(room).emit(event, payload); };

/** Send to the job's owner, anyone watching that job, and the admin console. */
function toJob(job, event, payload = {}) {
  const body = { jobId: job.public_id, at: new Date().toISOString(), ...payload };
  emit(`job:${job.public_id}`, event, body);
  emit(`user:${job.user_id}`, event, body);
  emit('admin', event, body);
}
const toUser = (userId, event, payload) => emit(`user:${userId}`, event, payload);
const toAdmin = (event, payload) => emit('admin', event, payload);
const toPrinter = (code, event, payload) => {
  emit(`printer:${code}`, event, payload);
  emit('admin', event, payload);
};

module.exports = { attach, emit, toJob, toUser, toAdmin, toPrinter, get io() { return io; } };

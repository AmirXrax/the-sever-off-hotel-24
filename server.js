'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = 96;
const FLOOR_CAPACITY = 4;
const MIN_FLOOR = -3;
const MAX_FLOOR = 24;
const PUBLIC_DIR = path.join(__dirname, 'public');

const players = new Map();
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('صفحه پیدا نشد');
      return;
    }
    res.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname);
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = path.resolve(PUBLIC_DIR, requested);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  sendFile(res, filePath);
});

const io = new Server(server, {
  serveClient: true,
  maxHttpBufferSize: 10_000,
  pingInterval: 25_000,
  pingTimeout: 20_000
});

function getOccupancy() {
  const occupancy = {};
  for (let floor = MIN_FLOOR; floor <= MAX_FLOOR; floor += 1) occupancy[floor] = 0;
  for (const player of players.values()) occupancy[player.floor] += 1;
  return occupancy;
}

function publicState() {
  const occupancy = getOccupancy();
  const publicPlayers = [...players.values()].map((player) => ({
    id: player.id,
    name: player.name,
    floor: player.floor,
    color: player.color,
    hasKey: player.hasKey
  }));
  return {
    players: publicPlayers,
    occupancy,
    online: players.size,
    maxPlayers: MAX_PLAYERS,
    floorCapacity: FLOOR_CAPACITY,
    floors: { min: MIN_FLOOR, max: MAX_FLOOR }
  };
}

function broadcastState() {
  io.emit('worldState', publicState());
}

function countOnFloor(floor) {
  let count = 0;
  for (const player of players.values()) if (player.floor === floor) count += 1;
  return count;
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[<>\u0000-\u001f]/g, '').trim().slice(0, 18);
}

function reply(callback, payload) {
  if (typeof callback === 'function') callback(payload);
}

const COLORS = ['#ffca74', '#8bd5c6', '#b7a3ef', '#f39bb4', '#8ebcf3', '#b2d58a', '#f2a875', '#a7b6c7'];

io.on('connection', (socket) => {
  socket.emit('worldState', publicState());

  socket.on('join', (payload = {}, callback) => {
    if (players.has(socket.id)) {
      reply(callback, { ok: false, message: 'شما همین حالا وارد بازی شده‌اید.' });
      return;
    }

    const name = cleanName(payload.name);
    const requestedFloor = Number(payload.floor);
    if (name.length < 2) {
      reply(callback, { ok: false, message: 'اسم باید حداقل ۲ حرف داشته باشد.' });
      return;
    }
    if (!Number.isInteger(requestedFloor) || requestedFloor < 1 || requestedFloor > 24) {
      reply(callback, { ok: false, message: 'طبقه باید بین ۱ تا ۲۴ باشد.' });
      return;
    }
    if (players.size >= MAX_PLAYERS) {
      reply(callback, { ok: false, message: 'ظرفیت کل هتل پر شده است؛ فعلاً نمی‌توانی وارد شوی.' });
      return;
    }
    if (countOnFloor(requestedFloor) >= FLOOR_CAPACITY) {
      reply(callback, { ok: false, message: `طبقه ${requestedFloor} پر است! نمی‌توانی وارد شوی؛ یک طبقه دیگر انتخاب کن.` });
      return;
    }

    const player = {
      id: socket.id,
      name,
      floor: requestedFloor,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      hasKey: false,
      joinedAt: Date.now()
    };
    players.set(socket.id, player);
    reply(callback, { ok: true, playerId: socket.id, player: { ...player } });
    broadcastState();
  });

  socket.on('moveFloor', (payload = {}, callback) => {
    const player = players.get(socket.id);
    if (!player) {
      reply(callback, { ok: false, message: 'اول باید وارد هتل شوی.' });
      return;
    }

    const target = Number(payload.floor);
    if (!Number.isInteger(target) || target < MIN_FLOOR || target > MAX_FLOOR) {
      reply(callback, { ok: false, message: 'این طبقه وجود ندارد.' });
      return;
    }
    if (target >= player.floor) {
      reply(callback, { ok: false, message: 'فقط می‌توانی به طبقه پایین‌تر بروی؛ رفتن به بالا ممنوع است.' });
      return;
    }
    if (target < 0 && player.floor > 0) {
      reply(callback, { ok: false, message: 'اول باید با کلید وارد طبقه صفر شوی.' });
      return;
    }
    if (target === 0 && !player.hasKey) {
      reply(callback, { ok: false, message: 'درِ طبقه صفر قفل است. اول در طبقه ۱ کلید را پیدا کن.' });
      return;
    }
    if (countOnFloor(target) >= FLOOR_CAPACITY) {
      reply(callback, { ok: false, message: `طبقه ${target} پر است! یک طبقه پایین‌تر را امتحان کن.` });
      return;
    }

    const oldFloor = player.floor;
    player.floor = target;
    reply(callback, { ok: true, message: `با آسانسور از طبقه ${oldFloor} به طبقه ${target} رفتی.` });
    broadcastState();
  });

  socket.on('collectKey', (_payload, callback) => {
    const player = players.get(socket.id);
    if (!player) {
      reply(callback, { ok: false, message: 'اول باید وارد هتل شوی.' });
      return;
    }
    if (player.floor !== 1) {
      reply(callback, { ok: false, message: 'جعبه کلید فقط در طبقه ۱ قرار دارد.' });
      return;
    }
    if (player.hasKey) {
      reply(callback, { ok: true, message: 'کلید را قبلاً برداشته‌ای.' });
      return;
    }
    player.hasKey = true;
    reply(callback, { ok: true, message: 'کلید طبقه صفر را پیدا کردی! حالا در باز می‌شود.' });
    broadcastState();
  });

  socket.on('disconnect', () => {
    if (players.delete(socket.id)) broadcastState();
  });
});

server.listen(PORT, HOST, () => {
  console.log(`HOTEL 96 is running at http://${HOST}:${PORT}`);
});

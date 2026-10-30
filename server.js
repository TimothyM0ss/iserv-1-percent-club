'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const multer = require('multer');
const { Server } = require('socket.io');
const { Game } = require('./lib/game');
const { Store, ValidationError } = require('./lib/store');

const COOKIE = 'iserv_admin';
const SESSION_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_ATTEMPTS = 8;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const BROADCAST_DEBOUNCE_MS = 80;

function readCookie(header, name) {
  const match = String(header ?? '')
    .split(';')
    .map((part) => part.trim().split('='))
    .find(([key]) => key === name);
  return match ? match[1] : null;
}

function safeEqual(a, b) {
  const hash = (value) => crypto.createHash('sha256').update(String(value)).digest();
  return crypto.timingSafeEqual(hash(a), hash(b));
}

function createServer({
  adminPassword,
  dataDir = path.join(__dirname, 'data'),
  questionMs = 30000,
  production = process.env.NODE_ENV === 'production',
} = {}) {
  const store = new Store(dataDir);
  store.init();

  const sessions = new Map();
  const attempts = new Map();

  const isAdmin = (cookieHeader) => {
    const token = readCookie(cookieHeader, COOKIE);
    const expires = token && sessions.get(token);
    if (!expires) return false;
    if (expires < Date.now()) {
      sessions.delete(token);
      return false;
    }
    return true;
  };

  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: 1e4 });
  const adminIo = io.of('/admin');
  const screenIo = io.of('/screen');
  const screenState = () => ({ ...game.screenView(), serverNow: Date.now() });

  let broadcastTimer = null;
  const broadcastNow = () => {
    clearTimeout(broadcastTimer);
    broadcastTimer = null;
    const base = { ...game.publicView(), serverNow: Date.now() };
    for (const socket of io.sockets.sockets.values()) {
      socket.emit('state', { ...base, me: game.meView(socket.data.playerId) });
    }
    adminIo.emit('state', {
      ...game.adminView(),
      serverNow: Date.now(),
      selectedCount: store.selectedCount,
    });
    screenIo.emit('state', screenState());
  };
  const game = new Game({
    questionMs,
    onChange: (immediate) => {
      if (immediate) return broadcastNow();
      broadcastTimer ??= setTimeout(broadcastNow, BROADCAST_DEBOUNCE_MS);
    },
  });

  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          ...helmet.contentSecurityPolicy.getDefaultDirectives(),
          'img-src': ["'self'"],
          'upgrade-insecure-requests': production ? [] : null,
        },
      },
    }),
  );
  app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));
  app.use('/uploads', express.static(store.uploadDir, { maxAge: '7d', immutable: true, index: false }));
  app.get('/favicon.ico', (req, res) => res.status(204).end());
  app.get('/healthz', (req, res) => res.json({ ok: true }));

  const api = express.Router();
  api.use(express.json({ limit: '60mb' }));

  api.post('/login', (req, res) => {
    const entry = attempts.get(req.ip);
    if (entry && entry.resetAt > Date.now() && entry.count >= LOGIN_ATTEMPTS) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' });
    }
    if (!entry || entry.resetAt <= Date.now()) attempts.set(req.ip, { count: 0, resetAt: Date.now() + LOGIN_WINDOW_MS });
    if (!safeEqual(req.body?.password ?? '', adminPassword)) {
      attempts.get(req.ip).count += 1;
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    attempts.delete(req.ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_MS);
    res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'strict', secure: production, maxAge: SESSION_MS });
    res.json({ ok: true });
  });

  api.use((req, res, next) => {
    if (isAdmin(req.headers.cookie)) return next();
    res.status(401).json({ error: 'Sign in required.' });
  });

  api.get('/session', (req, res) => res.json({ ok: true }));
  api.post('/logout', (req, res) => {
    sessions.delete(readCookie(req.headers.cookie, COOKIE));
    res.clearCookie(COOKIE);
    res.json({ ok: true });
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 5 } }).fields([
    { name: 'image', maxCount: 1 },
    ...[0, 1, 2, 3].map((i) => ({ name: `answerImage${i}`, maxCount: 1 })),
  ]);
  const answerUploads = (req) => [0, 1, 2, 3].map((i) => req.files?.[`answerImage${i}`]?.[0]?.buffer);
  const parseFields = (req) => {
    try {
      return JSON.parse(req.body?.data ?? '{}');
    } catch {
      throw new ValidationError('The question data could not be read.');
    }
  };

  api.get('/questions', (req, res) => res.json({ questions: store.list() }));
  api.post('/questions', upload, (req, res) => {
    store.add(parseFields(req), req.files?.image?.[0]?.buffer, answerUploads(req));
    broadcastNow();
    res.status(201).json({ questions: store.list() });
  });
  api.put('/questions/:id', upload, (req, res) => {
    store.update(req.params.id, parseFields(req), req.files?.image?.[0]?.buffer, answerUploads(req));
    broadcastNow();
    res.json({ questions: store.list() });
  });
  api.delete('/questions/:id', (req, res) => {
    store.remove(req.params.id);
    broadcastNow();
    res.json({ questions: store.list() });
  });
  api.post('/selection', (req, res) => {
    store.select(req.body?.ids);
    broadcastNow();
    res.json({ questions: store.list() });
  });
  api.get('/export', (req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="iserv-1-percent-club-questions.json"');
    res.json(store.exportPack());
  });
  api.post('/import', (req, res) => {
    store.importPack(req.body);
    broadcastNow();
    res.json({ questions: store.list() });
  });

  app.use('/api/admin', api);

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
    if (error instanceof multer.MulterError) {
      const message = error.code === 'LIMIT_FILE_SIZE' ? 'The image must be 3 MB or smaller.' : error.message;
      return res.status(400).json({ error: message });
    }
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'That file is too large.' });
    console.error(error);
    res.status(500).json({ error: 'Something went wrong.' });
  });

  io.on('connection', (socket) => {
    socket.on('join', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const { player, error } = game.join(payload?.name, payload?.token);
      if (error) return reply({ ok: false, error });
      socket.data.playerId = player.id;
      reply({ ok: true, token: player.token });
      socket.emit('state', { ...game.publicView(), serverNow: Date.now(), me: game.meView(player.id) });
    });

    socket.on('answer', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const result = game.answer(socket.data.playerId, payload?.choice);
      reply(result.error ? { ok: false, error: result.error } : { ok: true });
      if (!result.error) socket.emit('me', game.meView(socket.data.playerId));
    });

    socket.on('disconnect', () => {
      const id = socket.data.playerId;
      const stillOpen = [...io.sockets.sockets.values()].some((s) => s.data.playerId === id);
      if (id && !stillOpen) game.setConnected(id, false);
    });
  });

  screenIo.on('connection', (socket) => socket.emit('state', screenState()));

  adminIo.use((socket, next) => {
    if (isAdmin(socket.handshake.headers.cookie)) return next();
    next(new Error('unauthorised'));
  });

  adminIo.on('connection', (socket) => {
    socket.emit('state', { ...game.adminView(), serverNow: Date.now(), selectedCount: store.selectedCount });
    const command = (name, run) =>
      socket.on(name, (payload, ack) => {
        const reply = typeof ack === 'function' ? ack : typeof payload === 'function' ? payload : () => {};
        const result = run(typeof payload === 'function' ? undefined : payload) ?? { ok: true };
        reply(result.error ? { ok: false, error: result.error } : { ok: true });
      });

    command('start', () => game.start(store.gameQuestions()));
    command('next', () => game.next());
    command('reset', () => game.reset());
    command('kick', (id) => {
      if (!game.remove(id)) return { error: 'Player not found.' };
      for (const s of io.sockets.sockets.values()) {
        if (s.data.playerId === id) {
          s.data.playerId = null;
          s.emit('kicked');
        }
      }
    });
  });

  return { app, server, io, game, store };
}

if (require.main === module) {
  const production = process.env.NODE_ENV === 'production';
  let adminPassword = process.env.ADMIN_PASSWORD;
  if (!adminPassword) {
    if (production) {
      console.error('ADMIN_PASSWORD must be set in production.');
      process.exit(1);
    }
    adminPassword = crypto.randomBytes(6).toString('hex');
    console.log(`No ADMIN_PASSWORD set. Temporary local admin password: ${adminPassword}`);
  }
  const { server } = createServer({
    adminPassword,
    dataDir: process.env.DATA_DIR || path.join(__dirname, 'data'),
    production,
  });
  const port = process.env.PORT || 3000;
  server.listen(port, () => console.log(`iServ 1% Club listening on http://localhost:${port}`));
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}

module.exports = { createServer };

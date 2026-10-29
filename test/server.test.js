'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { io: connect } = require('socket.io-client');
const { createServer } = require('../server');

const PASSWORD = 'test-password';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

const emit = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));
const waitFor = (socket, event, predicate = () => true) =>
  new Promise((resolve) => {
    const handler = (data) => {
      if (predicate(data)) {
        socket.off(event, handler);
        resolve(data);
      }
    };
    socket.on(event, handler);
  });

test('a full game over real sockets', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'club-'));
  const { server, io, store } = createServer({ adminPassword: PASSWORD, dataDir, questionMs: 300 });
  await new Promise((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${server.address().port}`;
  t.after(() => {
    io.close();
    server.closeAllConnections();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  assert.equal((await fetch(`${base}/api/admin/questions`)).status, 401);
  assert.equal(
    (await fetch(`${base}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    })).status,
    401,
  );
  const login = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const badForm = new FormData();
  badForm.set('data', JSON.stringify({ difficulty: 50, answers: ['a', 'b', 'c'], correctIndex: 0, reason: 'r' }));
  badForm.set('image', new Blob([Buffer.from('<svg></svg>')]), 'x.svg');
  const rejected = await fetch(`${base}/api/admin/questions`, { method: 'POST', headers: { cookie }, body: badForm });
  assert.equal(rejected.status, 400);

  for (let n = 0; n < 5; n += 1) {
    const form = new FormData();
    form.set('data', JSON.stringify({ difficulty: 80 - n * 15, order: n, answers: ['a', 'b', 'c', 'd'], correctIndex: 2, reason: 'Because.' }));
    form.set('image', new Blob([PNG]), 'q.png');
    if (n === 0) {
      form.set('data', JSON.stringify({ difficulty: 80, order: 0, answers: [{ text: 'a' }, { text: '' }, { text: 'c' }], correctIndex: 2, reason: 'Because.' }));
      form.set('answerImage1', new Blob([PNG]), 'a.png');
    }
    const res = await fetch(`${base}/api/admin/questions`, { method: 'POST', headers: { cookie }, body: form });
    assert.equal(res.status, 201);
  }
  const ids = store.list().map((q) => q.id);
  const select = await fetch(`${base}/api/admin/selection`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ ids }),
  });
  assert.equal(select.status, 200);
  assert.deepEqual(store.list().map((q) => q.difficulty), [80, 65, 50, 35, 20]);
  assert.match(store.list()[0].answers[1].imageUrl, /^\/uploads\/.+\.png$/);

  const noCookie = connect(`${base}/admin`, { autoConnect: true, reconnection: false });
  await new Promise((resolve) => noCookie.on('connect_error', resolve));
  noCookie.close();

  const admin = connect(`${base}/admin`, { extraHeaders: { cookie }, transports: ['websocket'] });
  await new Promise((resolve) => admin.on('connect', resolve));

  const screen = connect(`${base}/screen`, { transports: ['websocket'] });
  const screenLobby = await waitFor(screen, 'state');
  assert.equal(screenLobby.phase, 'lobby');

  const ada = connect(base, { transports: ['websocket'] });
  const bea = connect(base, { transports: ['websocket'] });
  const adaJoin = await emit(ada, 'join', { name: 'Ada' });
  const beaJoin = await emit(bea, 'join', { name: 'Bea' });
  assert.ok(adaJoin.ok && beaJoin.ok);
  const anonymous = connect(base, { transports: ['websocket'] });
  assert.equal((await emit(anonymous, 'join', { name: ' ' })).ok, false);
  anonymous.close();

  const started = await emit(admin, 'start');
  assert.equal(started.ok, true);
  const late = connect(base, { transports: ['websocket'] });
  await emit(late, 'join', { name: 'Late' });

  for (let round = 0; round < 5; round += 1) {
    const live = waitFor(ada, 'state', (s) => s.phase === 'question');
    const onScreen = waitFor(screen, 'state', (s) => s.phase === 'question');
    await emit(admin, 'next');
    const state = await live;
    assert.equal(state.question.correctIndex, undefined);
    assert.equal((await onScreen).question.correctIndex, undefined);
    assert.equal(state.me.spectator, false);
    await emit(ada, 'answer', { choice: 2 });
    await emit(bea, 'answer', { choice: round === 0 ? 0 : 2 });
    const reveal = await waitFor(ada, 'state', (s) => s.phase === 'reveal');
    assert.equal(reveal.question.correctIndex, 2);
    assert.equal(reveal.pot, 1000);
  }
  const finished = waitFor(ada, 'state', (s) => s.phase === 'finished');
  await emit(admin, 'next');
  const end = await finished;
  assert.deepEqual(end.results.winners.map((w) => w.name), ['Ada']);
  assert.equal(end.results.share, 1000);

  for (const s of [admin, screen, ada, bea, late]) s.close();
});

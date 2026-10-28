'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Store, ValidationError } = require('../lib/store');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

function newStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new Store(dir);
  store.init();
  return store;
}

const fields = (answers) => ({ difficulty: 50, answers, correctIndex: 0, reason: 'Because.' });
const uploadedFiles = (store) => fs.readdirSync(store.uploadDir).length;

test('answers can be text, image or both', (t) => {
  const store = newStore(t);
  const q = store.add(fields([{ text: 'Cat' }, { text: '' }, { text: 'Dog' }]), PNG, [undefined, PNG]);
  assert.equal(q.answers[0].image, null);
  assert.ok(q.answers[1].image);
  assert.equal(uploadedFiles(store), 2);
  assert.equal(store.list()[0].answers[1].imageUrl, `/uploads/${q.answers[1].image}`);
});

test('an answer with neither text nor image is rejected and leaves no files behind', (t) => {
  const store = newStore(t);
  assert.throws(() => store.add(fields([{ text: 'A' }, { text: '' }, { text: 'C' }]), PNG, [PNG]), ValidationError);
  assert.equal(uploadedFiles(store), 0);
});

test('plain string answers from older data still load', (t) => {
  const store = newStore(t);
  const q = store.add(fields(['A', 'B', 'C']), PNG);
  store.init();
  assert.deepEqual(store.list()[0].answers.map((a) => a.text), ['A', 'B', 'C']);
  assert.equal(q.answers[0].image, null);
});

test('update keeps, replaces and clears answer images', (t) => {
  const store = newStore(t);
  const q = store.add(fields([{ text: 'A' }, { text: 'B' }, { text: 'C' }]), PNG, [PNG, PNG, PNG]);
  const [first, second, third] = q.answers.map((a) => a.image);
  store.update(q.id, fields([{ text: 'A', image: first }, { text: 'B', image: second }, { text: 'C', image: null }]), undefined, [undefined, PNG]);
  const after = store.questions[0].answers;
  assert.equal(after[0].image, first);
  assert.notEqual(after[1].image, second);
  assert.equal(after[2].image, null);
  const remaining = fs.readdirSync(store.uploadDir);
  assert.ok(remaining.includes(first));
  assert.ok(!remaining.includes(second));
  assert.ok(!remaining.includes(third));
});

test('update cannot point an answer at an image it does not own', (t) => {
  const store = newStore(t);
  const other = store.add(fields([{ text: 'A' }, { text: 'B' }, { text: 'C' }]), PNG);
  const q = store.add(fields([{ text: 'A' }, { text: 'B' }, { text: 'C' }]), PNG);
  store.update(q.id, fields([{ text: 'A', image: other.image }, { text: 'B' }, { text: 'C' }]));
  assert.equal(store.questions[1].answers[0].image, null);
});

test('delete removes every image the question owns', (t) => {
  const store = newStore(t);
  const q = store.add(fields([{ text: 'A' }, { text: 'B' }, { text: '' }]), PNG, [PNG, undefined, PNG]);
  store.remove(q.id);
  assert.equal(uploadedFiles(store), 0);
});

test('export then import round-trips image answers', (t) => {
  const store = newStore(t);
  store.add(fields([{ text: 'A' }, { text: '' }, { text: 'C' }]), PNG, [undefined, PNG]);
  const pack = JSON.parse(JSON.stringify(store.exportPack()));
  store.importPack(pack);
  assert.equal(store.questions.length, 1);
  assert.ok(store.questions[0].answers[1].image);
  assert.equal(uploadedFiles(store), 2);
});

test('game questions expose answer image urls but no file names', (t) => {
  const store = newStore(t);
  const q = store.add(fields([{ text: 'A' }, { text: 'B' }, { text: '' }]), PNG, [undefined, undefined, PNG]);
  store.select([q.id]);
  const [game] = store.gameQuestions();
  assert.deepEqual(Object.keys(game.answers[2]).sort(), ['imageUrl', 'text']);
  assert.match(game.answers[2].imageUrl, /^\/uploads\//);
});

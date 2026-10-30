'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { Game } = require('../lib/game');

const question = (n) => ({
  id: `q${n}`,
  imageUrl: `/uploads/${n}.png`,
  alt: '',
  answers: ['A', 'B', 'C'],
  correctIndex: 1,
  reason: 'Because.',
  difficulty: 90 - n * 10,
});
const fiveQuestions = () => [1, 2, 3, 4, 5].map(question);

function newGame() {
  const clock = { time: 0 };
  const game = new Game({ now: () => clock.time, questionMs: 60000 });
  return { game, clock };
}

function playRound(game, answers) {
  game.next();
  for (const [player, choice] of answers) game.answer(player.id, choice);
  game.lock();
}

test('join rejects blank, invalid and duplicate names', () => {
  const { game } = newGame();
  assert.ok(game.join('   ').error);
  assert.ok(game.join('<script>').error);
  assert.ok(game.join('Ada').player);
  assert.ok(game.join('ada').error);
});

test('join with a token returns the same player', () => {
  const { game } = newGame();
  const { player } = game.join('Ada');
  assert.equal(game.join('', player.token).player.id, player.id);
});

test('start needs exactly five questions and a player', () => {
  const { game } = newGame();
  assert.ok(game.start(fiveQuestions()).error);
  game.join('Ada');
  assert.ok(game.start([question(1)]).error);
  assert.ok(game.start(fiveQuestions()).ok);
  assert.equal(game.phase, 'ready');
  assert.equal(game.publicView().question, undefined);
});

test('players who join after the start are spectators', () => {
  const { game } = newGame();
  game.join('Ada');
  game.start(fiveQuestions());
  const { player } = game.join('Late');
  assert.equal(player.spectator, true);
  game.next();
  assert.ok(game.answer(player.id, 1).error);
});

test('wrong answer moves 1000 to the pot once and keeps the player in the game', () => {
  const { game } = newGame();
  const { player } = game.join('Ada');
  game.start(fiveQuestions());
  playRound(game, [[player, 0]]);
  assert.equal(game.pot, 1000);
  assert.equal(game.meView(player.id).credit, 0);
  playRound(game, [[player, 2]]);
  assert.equal(game.pot, 1000);
  playRound(game, [[player, 1]]);
  assert.equal(game.meView(player.id).score, 1);
});

test('no answer counts as wrong', () => {
  const { game } = newGame();
  const { player } = game.join('Ada');
  game.start(fiveQuestions());
  playRound(game, []);
  assert.equal(game.pot, 1000);
  assert.equal(game.meView(player.id).lastResult, 'wrong');
});

test('answers after the deadline are rejected', () => {
  const { game, clock } = newGame();
  const { player } = game.join('Ada');
  game.start(fiveQuestions());
  game.next();
  clock.time = 60001;
  assert.match(game.answer(player.id, 1).error, /locked/);
});

test('an answer is locked in after the first choice', () => {
  const { game } = newGame();
  const { player } = game.join('Ada');
  game.start(fiveQuestions());
  game.next();
  assert.ok(game.answer(player.id, 1).ok);
  assert.ok(game.answer(player.id, 0).error);
});

test('the question payload hides the answer until reveal', () => {
  const { game } = newGame();
  const { player } = game.join('Ada');
  game.start(fiveQuestions());
  game.next();
  assert.equal(game.publicView().question.correctIndex, undefined);
  assert.equal(game.publicView().question.reason, undefined);
  game.answer(player.id, 1);
  game.lock();
  assert.equal(game.publicView().question.correctIndex, 1);
});

test('the pot is shared equally between players who answer all five correctly', () => {
  const { game } = newGame();
  const winnerA = game.join('Ada').player;
  const winnerB = game.join('Bea').player;
  const loser1 = game.join('Cy').player;
  const loser2 = game.join('Di').player;
  const loser3 = game.join('Ed').player;
  game.start(fiveQuestions());
  playRound(game, [[winnerA, 1], [winnerB, 1], [loser1, 0], [loser2, 0], [loser3, 0]]);
  for (let i = 0; i < 4; i += 1) playRound(game, [[winnerA, 1], [winnerB, 1]]);
  game.next();
  assert.equal(game.phase, 'finished');
  assert.equal(game.results.pot, 3000);
  assert.equal(game.results.share, 1500);
  assert.deepEqual(game.results.winners.map((w) => w.name).sort(), ['Ada', 'Bea']);
});

test('the pot is unclaimed when nobody wins', () => {
  const { game } = newGame();
  const { player } = game.join('Ada');
  game.start(fiveQuestions());
  playRound(game, [[player, 0]]);
  for (let i = 0; i < 4; i += 1) playRound(game, [[player, 1]]);
  game.next();
  assert.equal(game.results.winners.length, 0);
  assert.equal(game.results.share, 0);
});

test('reset returns connected players to the lobby with a clean slate', () => {
  const { game } = newGame();
  const { player } = game.join('Ada');
  game.start(fiveQuestions());
  playRound(game, [[player, 0]]);
  game.reset();
  assert.equal(game.phase, 'lobby');
  assert.equal(game.pot, 0);
  assert.equal(game.meView(player.id).credit, 1000);
  assert.equal(game.meView(player.id).score, 0);
});

test('next cannot skip a live question', () => {
  const { game } = newGame();
  game.join('Ada');
  game.start(fiveQuestions());
  game.next();
  assert.ok(game.next().error);
  game.lock();
});

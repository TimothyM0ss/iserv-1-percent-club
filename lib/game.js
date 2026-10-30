'use strict';

const crypto = require('node:crypto');

const STAKE = 1000;
const QUESTIONS_PER_GAME = 5;
const MAX_PLAYERS = 300;
const LOBBY_DROP_MS = 15000;
const NAME_PATTERN = /^[\p{L}\p{N} _'.-]{1,20}$/u;

class Game {
  constructor({ now = Date.now, questionMs = 30000, onChange = () => {} } = {}) {
    this.now = now;
    this.questionMs = questionMs;
    this.onChange = onChange;
    this.players = new Map();
    this.timer = null;
    this.resetRound();
  }

  resetRound() {
    clearTimeout(this.timer);
    this.phase = 'lobby';
    this.questions = [];
    this.index = -1;
    this.deadline = 0;
    this.pot = 0;
    this.counts = [];
    this.results = null;
  }

  get currentQuestion() {
    return this.questions[this.index] ?? null;
  }

  get contestants() {
    return [...this.players.values()].filter((p) => !p.spectator);
  }

  join(rawName, token) {
    const returning = token && [...this.players.values()].find((p) => p.token === token);
    if (returning) {
      clearTimeout(returning.dropTimer);
      returning.connected = true;
      this.onChange(false);
      return { player: returning };
    }

    const name = String(rawName ?? '').replace(/\s+/g, ' ').trim();
    if (!NAME_PATTERN.test(name)) {
      return { error: 'Enter a name of 1 to 20 letters, numbers or spaces.' };
    }
    const lower = name.toLocaleLowerCase();
    if ([...this.players.values()].some((p) => p.name.toLocaleLowerCase() === lower)) {
      return { error: 'That name is taken. Try another.' };
    }
    if (this.players.size >= MAX_PLAYERS) {
      return { error: 'The game is full.' };
    }

    const player = {
      id: crypto.randomUUID(),
      token: crypto.randomBytes(16).toString('hex'),
      name,
      spectator: this.phase !== 'lobby',
      eliminated: false,
      score: 0,
      answer: null,
      lastResult: null,
      connected: true,
      dropTimer: null,
    };
    this.players.set(player.id, player);
    this.onChange(false);
    return { player };
  }

  setConnected(id, connected) {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = connected;
    clearTimeout(player.dropTimer);
    if (!connected && this.phase === 'lobby') {
      player.dropTimer = setTimeout(() => this.remove(player.id), LOBBY_DROP_MS);
      player.dropTimer.unref?.();
    }
    this.onChange(false);
  }

  remove(id) {
    const player = this.players.get(id);
    if (!player) return false;
    clearTimeout(player.dropTimer);
    this.players.delete(id);
    this.onChange(false);
    return true;
  }

  start(questions) {
    if (this.phase !== 'lobby') return { error: 'A game is already in progress.' };
    if (questions.length !== QUESTIONS_PER_GAME) {
      return { error: `Select exactly ${QUESTIONS_PER_GAME} questions before starting.` };
    }
    if (this.contestants.length === 0) return { error: 'No players have joined yet.' };
    this.questions = questions;
    this.phase = 'ready';
    this.index = -1;
    this.onChange(true);
    return { ok: true };
  }

  next() {
    if (this.phase !== 'ready' && this.phase !== 'reveal') {
      return { error: 'Wait for the current question to finish.' };
    }
    if (this.index + 1 >= this.questions.length) {
      this.finish();
      return { ok: true };
    }
    this.index += 1;
    this.phase = 'question';
    this.deadline = this.now() + this.questionMs;
    this.counts = [];
    for (const p of this.players.values()) {
      p.answer = null;
      p.lastResult = null;
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.lock(), this.questionMs);
    this.timer.unref?.();
    this.onChange(true);
    return { ok: true };
  }

  answer(id, choice) {
    const player = this.players.get(id);
    const question = this.currentQuestion;
    if (!player) return { error: 'Join the game first.' };
    if (player.spectator) return { error: 'Spectators cannot answer.' };
    if (this.phase !== 'question' || this.now() > this.deadline) {
      return { error: 'Answers are locked.' };
    }
    if (!Number.isInteger(choice) || choice < 0 || choice >= question.answers.length) {
      return { error: 'Choose one of the answers.' };
    }
    if (player.answer !== null) return { error: 'Your answer is already locked in.' };
    player.answer = choice;
    this.onChange(false);
    return { ok: true };
  }

  lock() {
    if (this.phase !== 'question') return;
    clearTimeout(this.timer);
    const question = this.currentQuestion;
    this.counts = question.answers.map(() => 0);
    for (const p of this.contestants) {
      if (p.answer !== null) this.counts[p.answer] += 1;
      const correct = p.answer === question.correctIndex;
      p.lastResult = correct ? 'correct' : 'wrong';
      if (correct) {
        p.score += 1;
      } else if (!p.eliminated) {
        p.eliminated = true;
        this.pot += STAKE;
      }
    }
    this.phase = 'reveal';
    this.onChange(true);
  }

  finish() {
    const winners = this.contestants.filter((p) => !p.eliminated && p.score === this.questions.length);
    const share = winners.length ? Math.floor(this.pot / winners.length) : 0;
    this.results = {
      pot: this.pot,
      share,
      winners: winners.map((p) => ({ id: p.id, name: p.name })),
      scoreboard: this.contestants
        .map((p) => ({ name: p.name, score: p.score, won: winners.includes(p) }))
        .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)),
    };
    this.phase = 'finished';
    this.onChange(true);
  }

  reset() {
    this.resetRound();
    for (const p of [...this.players.values()]) {
      if (!p.connected) {
        this.remove(p.id);
        continue;
      }
      Object.assign(p, { spectator: false, eliminated: false, score: 0, answer: null, lastResult: null });
    }
    this.onChange(true);
  }

  publicView() {
    const showQuestion = this.phase === 'question' || this.phase === 'reveal';
    const question = this.currentQuestion;
    const view = {
      phase: this.phase,
      pot: this.pot,
      stake: STAKE,
      total: this.questions.length || QUESTIONS_PER_GAME,
      number: this.index + 1,
      deadline: this.phase === 'question' ? this.deadline : null,
      questionMs: this.questionMs,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        spectator: p.spectator,
        eliminated: p.eliminated,
        connected: p.connected,
      })),
    };
    if (showQuestion) {
      view.question = {
        text: question.text,
        imageUrl: question.imageUrl,
        alt: question.alt,
        answers: question.answers,
        difficulty: question.difficulty,
      };
    }
    if (this.phase === 'reveal') {
      view.question.correctIndex = question.correctIndex;
      view.question.reason = question.reason;
      view.counts = this.counts;
      view.isLast = this.index === this.questions.length - 1;
    }
    if (this.phase === 'finished') view.results = this.results;
    return view;
  }

  meView(id) {
    const p = this.players.get(id);
    if (!p) return null;
    return {
      name: p.name,
      spectator: p.spectator,
      eliminated: p.eliminated,
      score: p.score,
      credit: p.spectator || p.eliminated ? 0 : STAKE,
      answer: p.answer,
      lastResult: p.lastResult,
    };
  }

  screenView() {
    return {
      ...this.publicView(),
      answered: this.contestants.filter((p) => p.answer !== null).length,
      contestants: this.contestants.length,
    };
  }

  adminView() {
    const view = this.publicView();
    const question = this.currentQuestion;
    if (question && (this.phase === 'question' || this.phase === 'reveal')) {
      view.question = { ...view.question, correctIndex: question.correctIndex, reason: question.reason };
    }
    view.answered = this.contestants.filter((p) => p.answer !== null).length;
    view.contestants = this.contestants.length;
    view.players = [...this.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      spectator: p.spectator,
      eliminated: p.eliminated,
      connected: p.connected,
      score: p.score,
      answered: p.answer !== null,
    }));
    return view;
  }
}

module.exports = { Game, STAKE, QUESTIONS_PER_GAME };

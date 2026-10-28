'use strict';

const socket = io();
const $ = (id) => document.getElementById(id);
const LETTERS = 'ABCD';
const LOW_SECONDS = 10;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

let state = null;
let me = null;
let joined = false;
let clockOffset = 0;
let stageKey = '';
let potShown = 0;
let timerFrame = 0;
let announcedLow = false;
const coins = new Map();

const memory = {
  get(key) {
    try { return sessionStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { value == null ? sessionStorage.removeItem(key) : sessionStorage.setItem(key, value); } catch { /* storage blocked */ }
  },
};

const announce = (text) => { $('live').textContent = ''; setTimeout(() => { $('live').textContent = text; }, 50); };
const sendJoin = (name, token) => new Promise((resolve) => socket.emit('join', { name, token }, resolve));

function showJoin(message = '') {
  joined = false;
  $('game').hidden = true;
  $('join').hidden = false;
  $('joinError').textContent = message;
  $('joinButton').disabled = false;
  $('nameInput').value = memory.get('name') ?? '';
}

function enterGame() {
  joined = true;
  $('join').hidden = true;
  $('game').hidden = false;
  if (state && me) render();
  $('stage').focus({ preventScroll: true });
}

$('joinForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('nameInput').value.trim();
  if (!name) {
    $('joinError').textContent = 'Enter a name to play.';
    $('nameInput').focus();
    return;
  }
  $('joinButton').disabled = true;
  $('joinError').textContent = '';
  const result = await sendJoin(name, null);
  if (!result.ok) {
    $('joinError').textContent = result.error;
    $('joinButton').disabled = false;
    $('nameInput').focus();
    return;
  }
  memory.set('token', result.token);
  memory.set('name', name);
  enterGame();
});

socket.on('connect', async () => {
  $('connection').hidden = true;
  const token = memory.get('token');
  if (!token) return;
  const result = await sendJoin(memory.get('name'), token);
  if (result.ok) {
    memory.set('token', result.token);
    if (!joined) enterGame();
  } else {
    memory.set('token', null);
    showJoin(result.error);
  }
});

socket.on('disconnect', () => { $('connection').hidden = false; });

socket.on('kicked', () => {
  memory.set('token', null);
  showJoin('The host removed you from the game. You can rejoin with a new name.');
});

socket.on('state', (incoming) => {
  clockOffset = incoming.serverNow - Date.now();
  state = incoming;
  me = incoming.me;
  if (joined && me) render();
});

socket.on('me', (incoming) => {
  me = incoming;
  if (joined && state) { renderMe(); renderStage(); }
});

function render() {
  renderMe();
  renderRing();
  renderPot();
  renderStage();
}

function chip(text, className = '', label) {
  return h('span', { class: `chip ${className}`.trim(), 'aria-label': label }, text);
}

function renderMe() {
  if (me.spectator) {
    $('me').replaceChildren(chip('Spectating'));
    return;
  }
  $('me').replaceChildren(
    chip(`Score ${me.score}/${state.total}`, '', `Score ${me.score} out of ${state.total}`),
    chip(`${formatNumber(me.credit)} $AGEs`, me.credit ? 'credit' : 'credit out', me.credit ? 'Credit 1,000 $AGEs' : 'Credit 0 $AGEs, you are out of the pot'),
  );
}

function renderPot() {
  $('potValue').textContent = formatNumber(potShown);
}

function coinSize(count) {
  if (count <= 12) return 76;
  if (count <= 30) return 58;
  if (count <= 60) return 46;
  return 36;
}

function buildCoin(player) {
  const mine = player.name === me.name;
  return h(
    'div',
    { class: `coin-wrap${mine ? ' mine' : ''}`, title: player.name },
    h('div', { class: 'coin' }, '1,000', h('small', {}, '$AGEs')),
    h('span', { class: 'coin-name' }, mine ? `${player.name} (you)` : player.name),
  );
}

function renderRing() {
  const ring = $('ring');
  const contestants = state.players.filter((p) => !p.spectator);
  const byId = new Map(state.players.map((p) => [p.id, p]));
  ring.style.setProperty('--coin', `${coinSize(contestants.length)}px`);
  ring.classList.toggle('dense', contestants.length > 24);

  let flights = 0;
  for (const [id, el] of coins) {
    const player = byId.get(id);
    if (player && !player.spectator && !player.eliminated) continue;
    coins.delete(id);
    if (player?.eliminated) flyToPot(el, flights++);
    else el.remove();
  }
  potShown = flights && !reducedMotion.matches ? Math.max(0, state.pot - flights * state.stake) : state.pot;

  contestants.forEach((player, i) => {
    if (player.eliminated) return;
    let el = coins.get(player.id);
    if (!el) {
      el = buildCoin(player);
      coins.set(player.id, el);
      ring.append(el);
    }
    const angle = -Math.PI / 2 + ((i + 0.5) / contestants.length) * 2 * Math.PI;
    el.style.setProperty('--x', `${50 + 46 * Math.cos(angle)}%`);
    el.style.setProperty('--y', `${50 + 43 * Math.sin(angle)}%`);
    el.classList.toggle('away', !player.connected);
  });
}

function flyToPot(el, index) {
  const from = el.querySelector('.coin').getBoundingClientRect();
  el.remove();
  if (reducedMotion.matches) return;
  const target = $('potValue').getBoundingClientRect();
  const clone = h('div', { class: 'coin flying' }, '1,000', h('small', {}, '$AGEs'));
  clone.style.setProperty('--coin', `${from.width}px`);
  clone.style.left = `${from.left}px`;
  clone.style.top = `${from.top}px`;
  document.body.append(clone);
  const dx = target.left + target.width / 2 - (from.left + from.width / 2);
  const dy = target.top + target.height / 2 - (from.top + from.height / 2);
  clone.animate(
    [
      { transform: 'translate(0, 0) scale(1)', opacity: 1 },
      { transform: `translate(${dx}px, ${dy}px) scale(0.3)`, opacity: 0.9 },
    ],
    { duration: 850, delay: Math.min(index * 50, 600), easing: 'cubic-bezier(.45, 0, .7, .4)', fill: 'backwards' },
  ).finished.then(() => {
    clone.remove();
    potShown = Math.min(state.pot, potShown + state.stake);
    renderPot();
    $('pot').classList.remove('bump');
    void $('pot').offsetWidth;
    $('pot').classList.add('bump');
  });
}

function remainingMs() {
  return Math.max(0, state.deadline - (Date.now() + clockOffset));
}

function runTimer() {
  cancelAnimationFrame(timerFrame);
  const tick = () => {
    const fill = $('timerFill');
    if (!fill || state.phase !== 'question') return;
    const remaining = remainingMs();
    const seconds = Math.ceil(remaining / 1000);
    fill.style.transform = `scaleX(${remaining / state.questionMs})`;
    $('timerText').textContent = remaining > 0 ? `${seconds}s` : 'Locked';
    $('timer').classList.toggle('low', seconds <= LOW_SECONDS);
    if (seconds <= LOW_SECONDS && !announcedLow) {
      announcedLow = true;
      announce(`${LOW_SECONDS} seconds left`);
    }
    if (remaining === 0) {
      document.querySelectorAll('.answer').forEach((b) => { b.disabled = true; });
      return;
    }
    timerFrame = requestAnimationFrame(tick);
  };
  tick();
}

function choose(index) {
  if (me.spectator || me.answer !== null || state.phase !== 'question' || remainingMs() === 0) return;
  me.answer = index;
  announce('Answer locked in');
  renderStage();
  socket.emit('answer', { choice: index }, (result) => {
    if (result.ok) return;
    me.answer = null;
    renderStage();
    announce(result.error);
  });
}

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || !joined) return;
  const index = '1234'.includes(event.key) ? Number(event.key) - 1 : 'abcd'.indexOf(event.key.toLowerCase());
  const button = index >= 0 && event.key.length === 1 ? document.querySelectorAll('.answer')[index] : null;
  if (button && !button.disabled) button.click();
});

function answerButton(text, index, question) {
  const reveal = state.phase === 'reveal';
  const mine = me.answer === index;
  const correct = reveal && question.correctIndex === index;
  const wrongPick = reveal && mine && !correct;
  const classes = ['answer'];
  let note = null;
  if (correct) { classes.push('correct'); note = '✔ Correct answer'; }
  else if (wrongPick) { classes.push('wrong'); note = '✘ Your answer'; }
  else if (mine) { classes.push('selected'); note = 'Locked in'; }
  else if (reveal || me.answer !== null) classes.push('dim');
  if (correct && mine) note = '✔ Correct answer, and yours';
  return h(
    'button',
    { type: 'button', class: classes.join(' '), disabled: reveal || me.spectator || me.answer !== null, onclick: () => choose(index) },
    h('span', { class: 'key', 'aria-hidden': 'true' }, LETTERS[index]),
    h('span', {}, text),
    note && h('span', { class: 'note' }, note),
    reveal && h('span', { class: 'note count' }, `${state.counts[index]} chose this`),
  );
}

function resultBanner() {
  if (me.spectator) return h('div', { class: 'banner' }, 'You are watching this round.');
  if (me.lastResult === 'correct') {
    const detail = me.eliminated
      ? `Your score is ${me.score}/${state.total}. Your credit is already in the pot, but you can play on.`
      : 'You are still in the running for the pot.';
    return h('div', { class: 'banner good' }, h('strong', {}, 'Correct!'), h('p', {}, detail));
  }
  const lead = me.answer === null ? "Time's up. No answer counts as wrong." : 'Not quite.';
  return h('div', { class: 'banner bad' }, h('strong', {}, lead), h('p', {}, `Your ${formatNumber(state.stake)} $AGEs are in the pot. You can play on, but you can no longer win.`));
}

function questionStage() {
  const question = state.question;
  const reveal = state.phase === 'reveal';
  const nodes = [
    h('p', { class: 'q-meta' }, h('span', {}, `Question ${state.number} of ${state.total}`), h('span', { class: 'q-diff' }, `${Number(question.difficulty)}% get this right`)),
  ];
  if (!reveal) {
    nodes.push(h('div', { class: 'timer', id: 'timer', role: 'timer', 'aria-label': 'Time remaining' },
      h('div', { class: 'timer-bar' }, h('div', { class: 'timer-fill', id: 'timerFill' })),
      h('span', { class: 'timer-text', id: 'timerText' })));
  }
  nodes.push(
    h('img', { class: 'q-img', src: question.imageUrl, alt: question.alt || `Question ${state.number}`, decoding: 'async', fetchpriority: 'high' }),
    h('div', { class: 'answers', role: 'group', 'aria-label': 'Answers' }, question.answers.map((text, i) => answerButton(text, i, question))),
  );
  if (me.spectator && !reveal) nodes.push(h('div', { class: 'banner' }, 'You joined after the game started, so you are watching this one.'));
  if (reveal) {
    nodes.push(
      resultBanner(),
      h('div', { class: 'banner' }, h('strong', {}, 'Why'), h('p', {}, question.reason)),
      h('p', { class: 'fine pulse-dots' }, state.isLast ? 'That was the last question. Waiting for the host to show the results' : 'Waiting for the host to show the next question'),
    );
  }
  return h('div', {}, nodes);
}

function lobbyStage() {
  return h('div', { class: 'center' },
    h('h2', {}, me.spectator ? 'You are spectating' : `You are in, ${me.name}!`),
    h('p', { id: 'lobbyCount' }),
    h('p', { class: 'pulse-dots' }, 'Waiting for the host to start the game'),
    h('ul', { class: 'rules' },
      h('li', {}, 'Five questions, each harder than the last.'),
      h('li', {}, 'You have 30 seconds per question. Late answers do not count.'),
      h('li', {}, 'A wrong answer sends your 1,000 $AGEs to the pot. You can play on but cannot win.'),
      h('li', {}, 'Answer all five correctly to share the pot.'),
      h('li', {}, 'Keys 1 to 4, or A to D, pick an answer.')));
}

function finishedStage() {
  const { results } = state;
  const won = results.winners.some((w) => w.name === me.name);
  let heading = 'Game over';
  let detail = `${results.winners.length} ${results.winners.length === 1 ? 'player' : 'players'} cleared all five. Each takes ${formatNumber(results.share)} of the ${formatNumber(results.pot)} $AGEs in the pot.`;
  if (won) heading = `You won ${formatNumber(results.share)} $AGEs!`;
  if (!results.winners.length) {
    heading = 'Nobody cleared all five';
    detail = `The pot of ${formatNumber(results.pot)} $AGEs goes unclaimed.`;
  }
  return h('div', { class: 'center' },
    h('h2', {}, heading),
    h('p', {}, detail),
    results.winners.length > 0 && h('ul', { class: 'winners', 'aria-label': 'Winners' }, results.winners.map((w) => h('li', {}, w.name))),
    h('div', { class: 'board-wrap' },
      h('table', { class: 'board' },
        h('caption', {}, 'Final scores'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Player'), h('th', { scope: 'col' }, 'Score'), h('th', { scope: 'col' }, 'Result'))),
        h('tbody', {}, results.scoreboard.map((row) => h('tr', {}, h('td', {}, row.name), h('td', {}, `${row.score}/${state.total}`), h('td', {}, row.won ? 'Winner' : '')))))),
    h('p', { class: 'fine pulse-dots' }, 'Waiting for the host to start a new game'));
}

function readyStage() {
  return h('div', { class: 'center' },
    h('h2', {}, 'The game has started'),
    h('p', { class: 'pulse-dots' }, 'The first question appears when the host is ready'),
    me.spectator && h('div', { class: 'banner' }, 'You joined after the start, so you are watching this game.'));
}

function announcePhase() {
  if (state.phase === 'question') {
    announce(`Question ${state.number} of ${state.total}. ${Math.round(state.questionMs / 1000)} seconds. ${state.question.answers.map((a, i) => `${LETTERS[i]}: ${a}`).join('. ')}`);
  } else if (state.phase === 'reveal') {
    const correct = state.question.answers[state.question.correctIndex];
    const outcome = me.spectator ? '' : me.lastResult === 'correct' ? 'You were correct. ' : 'You were not correct. ';
    announce(`${outcome}The answer was ${LETTERS[state.question.correctIndex]}: ${correct}. ${state.question.reason}`);
  } else if (state.phase === 'finished') {
    announce('Game over. Final scores are on screen.');
  } else if (state.phase === 'ready') {
    announce('The game has started. Waiting for the first question.');
  }
}

function renderStage() {
  const key = [state.phase, state.number, me.spectator, me.answer, me.lastResult, state.question?.correctIndex, state.results ? 'done' : ''].join('|');
  const phaseKey = `${state.phase}|${state.number}`;
  if (key !== stageKey) {
    const phaseChanged = !stageKey.startsWith(phaseKey);
    stageKey = key;
    const builders = { lobby: lobbyStage, ready: readyStage, question: questionStage, reveal: questionStage, finished: finishedStage };
    $('stage').replaceChildren(builders[state.phase]());
    if (phaseChanged) {
      announcedLow = false;
      announcePhase();
    }
    if (state.phase === 'question') runTimer();
  }
  const count = $('lobbyCount');
  if (count) {
    const players = state.players.filter((p) => !p.spectator).length;
    count.textContent = `${players} ${players === 1 ? 'player is' : 'players are'} in the room`;
  }
}

if (memory.get('token')) $('join').hidden = true;

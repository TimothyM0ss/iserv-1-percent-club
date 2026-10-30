'use strict';

const socket = io('/screen');
const $ = (id) => document.getElementById(id);
const LETTERS = 'ABCD';
const LOW_SECONDS = 10;

let state = null;
let clockOffset = 0;
let stageKey = '';
let timerFrame = 0;

socket.on('connect', () => { $('connection').hidden = true; });
socket.on('disconnect', () => { $('connection').hidden = false; $('connection').textContent = 'Connection lost. Reconnecting…'; });

socket.on('state', (incoming) => {
  clockOffset = incoming.serverNow - Date.now();
  state = incoming;
  render();
});

const contestants = () => state.players.filter((p) => !p.spectator);

function renderTopbar() {
  $('potValue').textContent = formatNumber(state.pot);
  const players = contestants();
  $('remaining').replaceChildren(
    players.length
      ? h('span', { class: 'chip' }, `${players.filter((p) => !p.eliminated).length} of ${players.length} still in the running`)
      : '',
  );
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
    if (remaining > 0) timerFrame = requestAnimationFrame(tick);
  };
  tick();
}

function answerCard(answer, index) {
  const reveal = state.phase === 'reveal';
  const correct = reveal && state.question.correctIndex === index;
  const classes = ['screen-answer'];
  if (correct) classes.push('correct');
  else if (reveal) classes.push('dim');
  return h(
    'div',
    { class: classes.join(' ') },
    answer.imageUrl && h('img', { class: 'a-img', src: answer.imageUrl, alt: answer.text ? '' : `Answer ${LETTERS[index]}`, decoding: 'async' }),
    h('span', { class: 'key', 'aria-hidden': 'true' }, LETTERS[index]),
    h('span', {}, answer.text),
    correct && h('span', { class: 'note' }, '✔ Correct answer'),
    reveal && h('span', { class: 'note count' }, `${state.counts[index]} chose this`),
  );
}

function questionStage() {
  const { question } = state;
  const reveal = state.phase === 'reveal';
  const nodes = [
    h('p', { class: 'q-meta' }, h('span', {}, `Question ${state.number} of ${state.total}`), h('span', { class: 'q-diff' }, `${Number(question.difficulty)}% get this right`)),
  ];
  if (!reveal) {
    nodes.push(h('div', { class: 'timer', id: 'timer', role: 'timer', 'aria-label': 'Time remaining' },
      h('div', { class: 'timer-bar' }, h('div', { class: 'timer-fill', id: 'timerFill' })),
      h('span', { class: 'timer-text', id: 'timerText' })));
  }
  nodes.push(h('div', { class: 'screen-body' },
    h('img', { class: 'q-img', src: question.imageUrl, alt: question.alt || `Question ${state.number}`, decoding: 'async' }),
    h('div', { class: 'screen-answers' }, question.answers.map(answerCard))));
  if (reveal) nodes.push(h('div', { class: 'banner' }, h('strong', {}, 'Why'), h('p', {}, question.reason)));
  else nodes.push(h('p', { class: 'answered', id: 'answered' }));
  return h('div', {}, nodes);
}

function lobbyStage() {
  const names = contestants().map((p) => p.name);
  return h('div', { class: 'center' },
    h('h2', {}, 'Join the game'),
    h('p', {}, 'Open this address in your browser and enter a name:'),
    h('p', { class: 'join-url' }, location.origin),
    h('p', {}, 'Or scan this QR code:'),
    h('img', { class: 'join-qr', src: '/join-qr.png', alt: 'QR code to join the game', width: 200, height: 200 }),
    h('p', {}, `${names.length} ${names.length === 1 ? 'player is' : 'players are'} in the room`),
    h('ul', { class: 'names', 'aria-label': 'Players' }, names.map((name) => h('li', {}, name))));
}

function readyStage() {
  return h('div', { class: 'center' },
    h('h2', {}, 'The game has started'),
    h('p', { class: 'pulse-dots' }, 'The first question appears when the host is ready'));
}

function finishedStage() {
  const { results } = state;
  const heading = results.winners.length ? 'Game over' : 'Nobody cleared all five';
  const detail = results.winners.length
    ? `${results.winners.length} ${results.winners.length === 1 ? 'player' : 'players'} cleared all five. Each takes ${formatNumber(results.share)} of the ${formatNumber(results.pot)} $AGEs in the pot.`
    : `The pot of ${formatNumber(results.pot)} $AGEs goes unclaimed.`;
  return h('div', { class: 'center' },
    h('h2', {}, heading),
    h('p', {}, detail),
    results.winners.length > 0 && h('ul', { class: 'winners', 'aria-label': 'Winners' }, results.winners.map((w) => h('li', {}, w.name))),
    h('div', { class: 'board-wrap' },
      h('table', { class: 'board' },
        h('caption', {}, 'Final scores'),
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Player'), h('th', { scope: 'col' }, 'Score'), h('th', { scope: 'col' }, 'Result'))),
        h('tbody', {}, results.scoreboard.map((row) => h('tr', {}, h('td', {}, row.name), h('td', {}, `${row.score}/${state.total}`), h('td', {}, row.won ? 'Winner' : '')))))));
}

function render() {
  renderTopbar();
  const lobbyNames = state.phase === 'lobby' ? contestants().map((p) => p.name).join(',') : '';
  const key = [state.phase, state.number, lobbyNames].join('|');
  if (key !== stageKey) {
    stageKey = key;
    const builders = { lobby: lobbyStage, ready: readyStage, question: questionStage, reveal: questionStage, finished: finishedStage };
    $('stage').replaceChildren(builders[state.phase]());
    if (state.phase === 'question') runTimer();
  }
  const answered = $('answered');
  if (answered) answered.textContent = `${state.answered} of ${state.contestants} players have answered`;
}

'use strict';

const $ = (id) => document.getElementById(id);
const LETTERS = 'ABCD';
const SELECTION_SIZE = 5;
const PHASES = { lobby: 'Lobby', ready: 'Started', question: 'Question live', reveal: 'Answer shown', finished: 'Finished' };

let socket = null;
let state = null;
let questions = [];
let editing = null;
let noticeTimer = 0;
let clockOffset = 0;
let countdown = 0;

function notice(message, bad = false) {
  const el = $('notice');
  el.textContent = message;
  el.classList.toggle('bad', bad);
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, 6000);
}

async function api(path, options = {}) {
  const response = await fetch(`/api/admin${path}`, options);
  const body = await response.json().catch(() => ({}));
  if (response.status === 401 && path !== '/login') showLogin();
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

function showLogin() {
  socket?.close();
  socket = null;
  $('app').hidden = true;
  $('login').hidden = false;
  $('password').focus();
}

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  connectSocket();
  loadQuestions();
  resetForm();
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('loginError').textContent = '';
  try {
    await api('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: $('password').value }),
    });
    $('password').value = '';
    showApp();
  } catch (error) {
    $('loginError').textContent = error.message;
  }
});

$('logout').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

function connectSocket() {
  socket = io('/admin');
  socket.on('state', (incoming) => {
    state = incoming;
    clockOffset = incoming.serverNow - Date.now();
    renderControl();
    renderQuestions();
  });
  socket.on('connect_error', () => showLogin());
}

function command(name, payload) {
  return new Promise((resolve) => {
    const done = (result) => {
      if (!result.ok) notice(result.error, true);
      resolve(result);
    };
    payload === undefined ? socket.emit(name, done) : socket.emit(name, payload, done);
  });
}

$('startBtn').addEventListener('click', () => command('start'));
$('nextBtn').addEventListener('click', () => command('next'));
$('resetBtn').addEventListener('click', () => {
  const live = state && state.phase !== 'lobby' && state.phase !== 'finished';
  if (live && !confirm('End this game and return everyone to the lobby?')) return;
  command('reset');
});

function stat(label, value) {
  return h('div', { class: 'stat' }, h('dt', {}, label), h('dd', {}, String(value)));
}

function renderControl() {
  const s = state;
  const spectators = s.players.filter((p) => p.spectator).length;
  const stats = [
    stat('Phase', PHASES[s.phase]),
    stat('Players', s.contestants),
    stat('Spectators', spectators),
    stat('Pot ($AGEs)', s.pot.toLocaleString('en-GB')),
  ];
  if (s.phase === 'question' || s.phase === 'reveal') {
    stats.push(stat('Question', `${s.number} of ${s.total}`));
    stats.push(stat('Answered', `${s.answered} of ${s.contestants}`));
  }
  if (s.phase === 'question') stats.push(h('div', { class: 'stat' }, h('dt', {}, 'Time left'), h('dd', { id: 'hostTimer' }, '')));
  $('status').replaceChildren(...stats);

  $('startBtn').disabled = !(s.phase === 'lobby' && s.selectedCount === SELECTION_SIZE && s.contestants > 0);
  const next = $('nextBtn');
  next.disabled = !(s.phase === 'ready' || s.phase === 'reveal');
  next.textContent = {
    ready: 'Show question 1',
    reveal: s.isLast ? 'Show results' : `Show question ${s.number + 1}`,
    question: 'Question is live…',
  }[s.phase] ?? 'Next question';

  $('controlHint').textContent = {
    lobby: s.selectedCount === SELECTION_SIZE ? 'Waiting for players. Start when everyone is in. Anyone arriving after the start can only watch.' : `Select ${SELECTION_SIZE} questions below to enable the start button (${s.selectedCount} selected).`,
    ready: 'No question is visible yet. Show the first one when you are ready.',
    question: 'Answers lock automatically after 30 seconds, then the answer and reason appear.',
    reveal: 'Answer and reason are on screen. Show the next one when you are ready.',
    finished: 'Use "Reset to lobby" to play again with everyone who is still connected.',
  }[s.phase];

  renderHostQuestion();
  renderPlayers();
  runCountdown();
}

function renderHostQuestion() {
  const q = state.question;
  if (!q) return $('live-question').replaceChildren();
  $('live-question').replaceChildren(
    h('div', { class: 'host-q' },
      h('img', { src: q.imageUrl, alt: q.alt || 'Current question' }),
      h('div', {},
        h('strong', {}, `Question ${state.number} of ${state.total} (${Number(q.difficulty)}% get it right)`),
        h('ol', { type: 'A' }, q.answers.map((a, i) => h('li', { class: i === q.correctIndex ? 'right' : '' }, a, i === q.correctIndex ? ' (correct)' : ''))),
        h('p', { class: 'hint' }, `Why: ${q.reason}`))));
}

function renderPlayers() {
  $('playersSummary').textContent = `Players (${state.players.length})`;
  $('playerList').replaceChildren(...state.players.map((p) => {
    const flags = [p.spectator && 'spectator', p.eliminated && 'out', !p.connected && 'offline', state.phase === 'question' && !p.spectator && p.answered && 'answered'].filter(Boolean);
    return h('li', {},
      h('span', {}, p.name, flags.length ? ` (${flags.join(', ')})` : ''),
      h('button', { type: 'button', class: 'ghost danger small', 'aria-label': `Remove ${p.name}`, onclick: () => command('kick', p.id) }, 'Remove'));
  }));
}

function runCountdown() {
  clearInterval(countdown);
  if (state.phase !== 'question') return;
  const tick = () => {
    const el = $('hostTimer');
    if (!el) return;
    el.textContent = `${Math.max(0, Math.ceil((state.deadline - (Date.now() + clockOffset)) / 1000))}s`;
  };
  tick();
  countdown = setInterval(tick, 250);
}

async function loadQuestions() {
  try {
    ({ questions } = await api('/questions'));
    renderQuestions();
  } catch (error) {
    notice(error.message, true);
  }
}

function renderQuestions() {
  const selected = questions.filter((q) => q.selected).length;
  $('selectionStatus').textContent = selected === SELECTION_SIZE
    ? `${selected} of ${SELECTION_SIZE} selected. Ready to play.`
    : `${selected} of ${SELECTION_SIZE} selected.`;
  $('emptyQuestions').hidden = questions.length > 0;
  $('questionRows').replaceChildren(...questions.map((q) => h('tr', {},
    h('td', {}, h('input', { type: 'checkbox', checked: q.selected, 'aria-label': `Use question ${q.difficulty}% in the game`, disabled: state && state.phase !== 'lobby', onchange: (e) => toggleSelection(q.id, e.target) })),
    h('td', {}, h('img', { src: q.imageUrl, alt: q.alt || 'Question image' })),
    h('td', {}, `${q.difficulty}%`),
    h('td', {}, String(q.order)),
    h('td', { class: 'answers-cell' }, h('ol', { type: 'A' }, q.answers.map((a, i) => h('li', { class: i === q.correctIndex ? 'right' : '' }, a, i === q.correctIndex ? ' (correct)' : '')))),
    h('td', {}, h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'ghost small', onclick: () => startEdit(q) }, 'Edit'),
      h('button', { type: 'button', class: 'ghost danger small', onclick: () => removeQuestion(q) }, 'Delete'))))));
}

async function toggleSelection(id, checkbox) {
  const ids = new Set(questions.filter((q) => q.selected).map((q) => q.id));
  checkbox.checked ? ids.add(id) : ids.delete(id);
  if (ids.size > SELECTION_SIZE) {
    checkbox.checked = false;
    notice(`A game uses exactly ${SELECTION_SIZE} questions. Untick one first.`, true);
    return;
  }
  try {
    ({ questions } = await api('/selection', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [...ids] }) }));
    renderQuestions();
  } catch (error) {
    notice(error.message, true);
    loadQuestions();
  }
}

async function removeQuestion(q) {
  if (!confirm(`Delete the ${q.difficulty}% question? This cannot be undone.`)) return;
  try {
    ({ questions } = await api(`/questions/${q.id}`, { method: 'DELETE' }));
    if (editing === q.id) resetForm();
    renderQuestions();
  } catch (error) {
    notice(error.message, true);
  }
}

function answerRow(index, text = '', isCorrect = false) {
  return h('div', { class: 'answer-row' },
    h('input', { type: 'radio', name: 'correct', value: index, checked: isCorrect, 'aria-label': `Answer ${LETTERS[index]} is correct` }),
    h('input', { type: 'text', maxlength: 120, 'aria-label': `Answer ${LETTERS[index]}`, placeholder: `Answer ${LETTERS[index]}`, value: text }),
    h('button', { type: 'button', class: 'ghost small', 'aria-label': `Remove answer ${LETTERS[index]}`, onclick: (e) => removeAnswerRow(e.target.closest('.answer-row')) }, 'Remove'));
}

function renderAnswerRows(answers, correctIndex) {
  $('answerRows').replaceChildren(...answers.map((text, i) => answerRow(i, text, i === correctIndex)));
  syncAnswerControls();
}

function syncAnswerControls() {
  const rows = [...$('answerRows').children];
  rows.forEach((row, i) => {
    row.querySelector('input[type="radio"]').value = i;
    row.querySelector('input[type="radio"]').setAttribute('aria-label', `Answer ${LETTERS[i]} is correct`);
    const text = row.querySelector('input[type="text"]');
    text.setAttribute('aria-label', `Answer ${LETTERS[i]}`);
    text.placeholder = `Answer ${LETTERS[i]}`;
    const remove = row.querySelector('button');
    remove.disabled = rows.length <= 3;
    remove.setAttribute('aria-label', `Remove answer ${LETTERS[i]}`);
  });
  $('addAnswer').disabled = rows.length >= 4;
}

function removeAnswerRow(row) {
  row.remove();
  syncAnswerControls();
}

$('addAnswer').addEventListener('click', () => {
  $('answerRows').append(answerRow($('answerRows').children.length));
  syncAnswerControls();
  $('answerRows').lastElementChild.querySelector('input[type="text"]').focus();
});

$('qImage').addEventListener('change', () => {
  const file = $('qImage').files[0];
  const preview = $('imagePreview');
  if (!file) { preview.hidden = true; return; }
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
});

function resetForm() {
  editing = null;
  $('questionForm').reset();
  $('formTitle').textContent = 'Add a question';
  $('saveQuestion').textContent = 'Save question';
  $('cancelEdit').hidden = true;
  $('formError').textContent = '';
  $('imagePreview').hidden = true;
  renderAnswerRows(['', '', ''], -1);
}

function startEdit(q) {
  editing = q.id;
  $('formTitle').textContent = 'Edit question';
  $('saveQuestion').textContent = 'Update question';
  $('cancelEdit').hidden = false;
  $('formError').textContent = '';
  $('qImage').value = '';
  $('qAlt').value = q.alt;
  $('qDifficulty').value = q.difficulty;
  $('qOrder').value = q.order;
  $('qReason').value = q.reason;
  $('imagePreview').src = q.imageUrl;
  $('imagePreview').hidden = false;
  renderAnswerRows(q.answers, q.correctIndex);
  $('questionForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
  $('qDifficulty').focus({ preventScroll: true });
}

$('cancelEdit').addEventListener('click', resetForm);

$('questionForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const rows = [...$('answerRows').children];
  const checked = $('questionForm').querySelector('input[name="correct"]:checked');
  const file = $('qImage').files[0];
  const error = (message) => { $('formError').textContent = message; };

  if (!editing && !file) return error('Choose an image for the question.');
  if (!$('qDifficulty').value) return error('Enter the percentage who get it right.');
  if (rows.some((row) => !row.querySelector('input[type="text"]').value.trim())) return error('Fill in every answer, or remove the empty ones.');
  if (!checked) return error('Mark one answer as correct.');
  if (!$('qReason').value.trim()) return error('Explain why the answer is correct.');

  const form = new FormData();
  form.set('data', JSON.stringify({
    difficulty: $('qDifficulty').value,
    order: $('qOrder').value,
    alt: $('qAlt').value,
    reason: $('qReason').value,
    answers: rows.map((row) => row.querySelector('input[type="text"]').value),
    correctIndex: Number(checked.value),
  }));
  if (file) form.set('image', file);

  $('saveQuestion').disabled = true;
  try {
    ({ questions } = await api(editing ? `/questions/${editing}` : '/questions', { method: editing ? 'PUT' : 'POST', body: form }));
    notice(editing ? 'Question updated.' : 'Question added.');
    resetForm();
    renderQuestions();
  } catch (failure) {
    error(failure.message);
  } finally {
    $('saveQuestion').disabled = false;
  }
});

$('importBtn').addEventListener('click', () => $('importFile').click());

$('importFile').addEventListener('change', async () => {
  const file = $('importFile').files[0];
  $('importFile').value = '';
  if (!file) return;
  if (!confirm('Importing replaces all existing questions. Continue?')) return;
  try {
    const pack = JSON.parse(await file.text());
    ({ questions } = await api('/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pack) }));
    notice(`Imported ${questions.length} questions.`);
    resetForm();
    renderQuestions();
  } catch (failure) {
    notice(failure instanceof SyntaxError ? 'That file is not valid JSON.' : failure.message, true);
  }
});

api('/session').then(showApp, showLogin);

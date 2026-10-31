'use strict';

const $ = (id) => document.getElementById(id);
const LETTERS = 'ABCD';
const SELECTION_SIZE = 5;
const MIN_ANSWERS = 2;
const MAX_ANSWERS = 4;
const PHASES = { lobby: 'Lobby', ready: 'Started', question: 'Question live', reveal: 'Answer shown', finished: 'Finished' };

let socket = null;
let state = null;
let questions = [];
let editing = null;
let keepsQuestionImage = false;
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
    question: `Answers lock automatically after ${toSeconds(s.questionMs)} seconds, then the answer and reason appear.`,
    reveal: 'Answer and reason are on screen. Show the next one when you are ready.',
    finished: 'Use "Reset to lobby" to play again with everyone who is still connected.',
  }[s.phase];

  renderHostQuestion();
  renderPlayers();
  runCountdown();
}

function answerItem(answer, isCorrect) {
  return h('li', { class: isCorrect ? 'right' : '' },
    answer.imageUrl && h('img', { class: 'thumb', src: answer.imageUrl, alt: '' }),
    answer.text,
    isCorrect ? ' (correct)' : '');
}

function answerList(q) {
  if (q.kind === 'text') return h('p', { class: 'right' }, `Typed answer: ${q.correctText}`);
  return h('ol', { type: 'A' }, q.answers.map((a, i) => answerItem(a, i === q.correctIndex)));
}

function renderHostQuestion() {
  const q = state.question;
  if (!q) return $('live-question').replaceChildren();
  $('live-question').replaceChildren(
    h('div', { class: q.imageUrl ? 'host-q' : 'host-q no-img' },
      q.imageUrl && h('img', { src: q.imageUrl, alt: q.alt || 'Current question' }),
      h('div', {},
        h('strong', {}, `Question ${state.number} of ${state.total} (${Number(q.difficulty)}% get it right)`),
        q.text && h('p', { class: 'host-q-text' }, q.text),
        answerList(q),
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
    h('td', { class: 'question-cell' },
      q.imageUrl && h('img', { src: q.imageUrl, alt: q.alt || 'Question image' }),
      q.text && h('span', {}, q.text)),
    h('td', {}, `${q.difficulty}%`),
    h('td', {}, String(q.order)),
    h('td', { class: 'answers-cell' }, answerList(q)),
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

const emptyAnswer = () => ({ text: '', image: null, imageUrl: null });

function answerRow(index, answer = emptyAnswer(), isCorrect = false) {
  const thumb = h('img', { alt: '', hidden: !answer.imageUrl, src: answer.imageUrl });
  const file = h('input', {
    type: 'file',
    class: 'answer-file',
    accept: 'image/png,image/jpeg,image/gif,image/webp',
    onchange: () => {
      const chosen = file.files[0];
      if (!chosen) return;
      thumb.src = URL.createObjectURL(chosen);
      thumb.hidden = false;
      clear.hidden = false;
    },
  });
  const clear = h('button', {
    type: 'button',
    class: 'ghost small clear-image',
    hidden: !answer.imageUrl,
    onclick: () => {
      file.value = '';
      row.dataset.image = '';
      thumb.hidden = true;
      clear.hidden = true;
    },
  }, 'Clear image');
  const row = h('div', { class: 'answer-row', 'data-image': answer.image ?? '' },
    h('input', { type: 'radio', name: 'correct', value: index, checked: isCorrect }),
    h('input', { type: 'text', class: 'answer-text', maxlength: 120, value: answer.text }),
    h('button', { type: 'button', class: 'ghost small remove-answer', onclick: () => removeAnswerRow(row) }, 'Remove'),
    h('div', { class: 'answer-image' }, thumb, file, clear));
  return row;
}

function renderAnswerRows(answers, correctIndex) {
  $('answerRows').replaceChildren(...answers.map((a, i) => answerRow(i, a, i === correctIndex)));
  syncAnswerControls();
}

function syncAnswerControls() {
  const rows = [...$('answerRows').children];
  rows.forEach((row, i) => {
    const letter = LETTERS[i];
    row.querySelector('input[type="radio"]').value = i;
    row.querySelector('input[type="radio"]').setAttribute('aria-label', `Answer ${letter} is correct`);
    const text = row.querySelector('.answer-text');
    text.setAttribute('aria-label', `Answer ${letter} text`);
    text.placeholder = `Answer ${letter} text`;
    row.querySelector('.answer-file').setAttribute('aria-label', `Answer ${letter} image (optional)`);
    row.querySelector('.clear-image').setAttribute('aria-label', `Clear answer ${letter} image`);
    const remove = row.querySelector('.remove-answer');
    remove.disabled = rows.length <= MIN_ANSWERS;
    remove.setAttribute('aria-label', `Remove answer ${letter}`);
  });
  $('addAnswer').disabled = rows.length >= MAX_ANSWERS;
}

function syncKind() {
  const typed = $('qKind').value === 'text';
  $('typedFields').hidden = !typed;
  $('choiceFields').hidden = typed;
}

$('qKind').addEventListener('change', syncKind);

function removeAnswerRow(row) {
  row.remove();
  syncAnswerControls();
}

$('addAnswer').addEventListener('click', () => {
  $('answerRows').append(answerRow($('answerRows').children.length));
  syncAnswerControls();
  $('answerRows').lastElementChild.querySelector('.answer-text').focus();
});

$('qImage').addEventListener('change', () => {
  const file = $('qImage').files[0];
  const preview = $('imagePreview');
  if (!file) { preview.hidden = true; return; }
  preview.src = URL.createObjectURL(file);
  preview.hidden = false;
});

$('clearQImage').addEventListener('click', () => {
  keepsQuestionImage = false;
  $('qImage').value = '';
  $('imagePreview').hidden = true;
  $('clearQImage').hidden = true;
});

function resetForm() {
  editing = null;
  keepsQuestionImage = false;
  $('clearQImage').hidden = true;
  $('questionForm').reset();
  $('formTitle').textContent = 'Add a question';
  $('saveQuestion').textContent = 'Save question';
  $('cancelEdit').hidden = true;
  $('formError').textContent = '';
  $('imagePreview').hidden = true;
  syncKind();
  renderAnswerRows([emptyAnswer(), emptyAnswer(), emptyAnswer()], -1);
}

function startEdit(q) {
  editing = q.id;
  $('formTitle').textContent = 'Edit question';
  $('saveQuestion').textContent = 'Update question';
  $('cancelEdit').hidden = false;
  $('formError').textContent = '';
  $('qImage').value = '';
  $('qText').value = q.text;
  $('qAlt').value = q.alt;
  $('qDifficulty').value = q.difficulty;
  $('qOrder').value = q.order;
  $('qReason').value = q.reason;
  $('qKind').value = q.kind;
  $('qCorrectText').value = q.correctText;
  syncKind();
  keepsQuestionImage = Boolean(q.imageUrl);
  if (q.imageUrl) $('imagePreview').src = q.imageUrl;
  $('imagePreview').hidden = !q.imageUrl;
  $('clearQImage').hidden = !q.imageUrl;
  renderAnswerRows(q.kind === 'text' ? [emptyAnswer(), emptyAnswer(), emptyAnswer()] : q.answers, q.correctIndex);
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

  if (!$('qText').value.trim() && !file && !keepsQuestionImage) return error('Give the question some text, an image, or both.');
  if (!$('qDifficulty').value) return error('Enter the percentage who get it right.');
  const typed = $('qKind').value === 'text';
  const hasContent = (row) => row.querySelector('.answer-text').value.trim() || row.dataset.image || row.querySelector('.answer-file').files[0];
  if (typed && !$('qCorrectText').value.trim()) return error('Enter the correct answer players should type.');
  if (!typed && !rows.every(hasContent)) return error('Give every answer some text or an image, or remove the empty ones.');
  if (!typed && !checked) return error('Mark one answer as correct.');
  if (!$('qReason').value.trim()) return error('Explain why the answer is correct.');

  const form = new FormData();
  form.set('data', JSON.stringify({
    kind: $('qKind').value,
    correctText: $('qCorrectText').value,
    text: $('qText').value,
    clearImage: Boolean(editing) && !keepsQuestionImage,
    difficulty: $('qDifficulty').value,
    order: $('qOrder').value,
    alt: $('qAlt').value,
    reason: $('qReason').value,
    answers: typed ? [] : rows.map((row) => ({ text: row.querySelector('.answer-text').value, image: row.dataset.image || null })),
    correctIndex: typed ? null : Number(checked.value),
  }));
  if (file) form.set('image', file);
  if (!typed) {
    rows.forEach((row, i) => {
      const answerFile = row.querySelector('.answer-file').files[0];
      if (answerFile) form.set(`answerImage${i}`, answerFile);
    });
  }

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

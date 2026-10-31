'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_QUESTION_LENGTH = 300;
const MAX_ANSWER_LENGTH = 120;
const MAX_REASON_LENGTH = 600;
const MAX_ALT_LENGTH = 300;
const MIN_ANSWERS = 2;
const MAX_ANSWERS = 4;
const LETTERS = 'ABCD';

class ValidationError extends Error {}

function sniffImageExtension(buffer) {
  if (buffer.length < 12) return null;
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') return 'gif';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'webp';
  }
  return null;
}

function normaliseAnswer(item) {
  const source = typeof item === 'string' ? { text: item } : (item ?? {});
  return {
    text: String(source.text ?? '').trim(),
    image: typeof source.image === 'string' ? source.image : null,
    imageData: typeof source.imageData === 'string' ? source.imageData : null,
  };
}

function cleanFields(input) {
  const data = input ?? {};
  const difficulty = Number(data.difficulty);
  if (!Number.isFinite(difficulty) || difficulty < 0 || difficulty > 100) {
    throw new ValidationError('Difficulty must be a percentage from 0 to 100.');
  }
  const order = data.order === '' || data.order == null ? 0 : Number(data.order);
  if (!Number.isInteger(order) || order < 0) {
    throw new ValidationError('Display order must be a whole number, 0 or more.');
  }
  const text = String(data.text ?? '').trim();
  if (text.length > MAX_QUESTION_LENGTH) {
    throw new ValidationError(`Question text can be up to ${MAX_QUESTION_LENGTH} characters.`);
  }
  const kind = data.kind === 'text' ? 'text' : 'choice';
  const reason = String(data.reason ?? '').trim();
  if (!reason || reason.length > MAX_REASON_LENGTH) {
    throw new ValidationError(`Explain why the answer is correct (up to ${MAX_REASON_LENGTH} characters).`);
  }
  const alt = String(data.alt ?? '').trim().slice(0, MAX_ALT_LENGTH);
  const common = { kind, text, difficulty, order, reason, alt };
  return kind === 'text' ? { ...common, ...cleanTypedAnswer(data) } : { ...common, ...cleanChoices(data) };
}

function cleanTypedAnswer(data) {
  const correctText = String(data.correctText ?? '').trim();
  if (!/[\p{L}\p{N}]/u.test(correctText) || correctText.length > MAX_ANSWER_LENGTH) {
    throw new ValidationError(`Enter the correct answer, with at least one letter or number (up to ${MAX_ANSWER_LENGTH} characters).`);
  }
  return { answers: [], correctIndex: null, correctText };
}

function cleanChoices(data) {
  const answers = Array.isArray(data.answers) ? data.answers.map(normaliseAnswer) : [];
  if (answers.length < MIN_ANSWERS || answers.length > MAX_ANSWERS) {
    throw new ValidationError(`Provide ${MIN_ANSWERS} to ${MAX_ANSWERS} answers.`);
  }
  if (answers.some((a) => a.text.length > MAX_ANSWER_LENGTH)) {
    throw new ValidationError(`Answer text can be up to ${MAX_ANSWER_LENGTH} characters.`);
  }
  const correctIndex = Number(data.correctIndex);
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= answers.length) {
    throw new ValidationError('Mark exactly one answer as correct.');
  }
  return { answers, correctIndex, correctText: '' };
}

const NEEDS_PROMPT = 'Give the question some text, an image, or both.';

class Store {
  constructor(dir) {
    this.dir = dir;
    this.uploadDir = path.join(dir, 'uploads');
    this.file = path.join(dir, 'questions.json');
    this.questions = [];
  }

  init() {
    fs.mkdirSync(this.uploadDir, { recursive: true });
    if (fs.existsSync(this.file)) {
      this.questions = JSON.parse(fs.readFileSync(this.file, 'utf8')).map((q) => ({
        ...q,
        kind: q.kind ?? 'choice',
        correctText: q.correctText ?? '',
        text: q.text ?? '',
        answers: q.answers.map((a) => {
          const { text, image } = normaliseAnswer(a);
          return { text, image };
        }),
      }));
    }
  }

  save() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.questions, null, 2));
    fs.renameSync(temp, this.file);
  }

  list() {
    return [...this.questions]
      .sort((a, b) => b.difficulty - a.difficulty || a.order - b.order)
      .map((q) => ({
        ...q,
        imageUrl: q.image ? `/uploads/${q.image}` : null,
        answers: q.answers.map((a) => ({ ...a, imageUrl: a.image ? `/uploads/${a.image}` : null })),
      }));
  }

  get selectedCount() {
    return this.questions.filter((q) => q.selected).length;
  }

  gameQuestions() {
    return this.list()
      .filter((q) => q.selected)
      .map(({ id, kind, text, imageUrl, alt, answers, correctIndex, correctText, reason, difficulty }) => ({
        id,
        kind,
        text,
        imageUrl,
        alt,
        answers: answers.map(({ text, imageUrl: answerImage }) => ({ text, imageUrl: answerImage })),
        correctIndex,
        correctText,
        reason,
        difficulty,
      }));
  }

  writeImage(buffer) {
    const extension = sniffImageExtension(buffer ?? Buffer.alloc(0));
    if (!extension) throw new ValidationError('Images must be PNG, JPEG, GIF or WebP files.');
    const name = `${crypto.randomUUID()}.${extension}`;
    fs.writeFileSync(path.join(this.uploadDir, name), buffer);
    return name;
  }

  removeImage(name) {
    fs.rmSync(path.join(this.uploadDir, path.basename(name)), { force: true });
  }

  resolveAnswers(rawAnswers, uploads = [], previous = []) {
    const owned = new Set(previous.map((a) => a.image).filter(Boolean));
    const kept = new Set();
    const written = [];
    try {
      const answers = rawAnswers.map((raw, i) => {
        let image = null;
        const buffer = uploads[i] ?? (raw.imageData ? Buffer.from(raw.imageData, 'base64') : null);
        if (buffer) {
          image = this.writeImage(buffer);
          written.push(image);
        } else if (raw.image && owned.has(raw.image)) {
          image = raw.image;
          kept.add(image);
        }
        if (!raw.text && !image) {
          throw new ValidationError(`Answer ${LETTERS[i]} needs text, an image, or both.`);
        }
        return { text: raw.text, image };
      });
      return { answers, written, stale: [...owned].filter((name) => !kept.has(name)) };
    } catch (error) {
      written.forEach((name) => this.removeImage(name));
      throw error;
    }
  }

  add(input, imageBuffer, answerUploads) {
    const fields = cleanFields(input);
    if (!fields.text && !imageBuffer) throw new ValidationError(NEEDS_PROMPT);
    const resolved = this.resolveAnswers(fields.answers, answerUploads);
    let image = null;
    try {
      if (imageBuffer) image = this.writeImage(imageBuffer);
    } catch (error) {
      resolved.written.forEach((name) => this.removeImage(name));
      throw error;
    }
    const question = { id: crypto.randomUUID(), image, selected: false, ...fields, answers: resolved.answers };
    this.questions.push(question);
    this.save();
    return question;
  }

  update(id, input, imageBuffer, answerUploads) {
    const question = this.questions.find((q) => q.id === id);
    if (!question) throw new ValidationError('Question not found.');
    const fields = cleanFields(input);
    const previousImage = question.image;
    const keepsImage = !imageBuffer && input?.clearImage !== true && Boolean(previousImage);
    if (!fields.text && !imageBuffer && !keepsImage) throw new ValidationError(NEEDS_PROMPT);
    const resolved = this.resolveAnswers(fields.answers, answerUploads, question.answers);
    let image = keepsImage ? previousImage : null;
    try {
      if (imageBuffer) image = this.writeImage(imageBuffer);
    } catch (error) {
      resolved.written.forEach((name) => this.removeImage(name));
      throw error;
    }
    Object.assign(question, fields, { image, answers: resolved.answers });
    this.save();
    if (previousImage && image !== previousImage) this.removeImage(previousImage);
    resolved.stale.forEach((name) => this.removeImage(name));
    return question;
  }

  remove(id) {
    const index = this.questions.findIndex((q) => q.id === id);
    if (index === -1) throw new ValidationError('Question not found.');
    const [removed] = this.questions.splice(index, 1);
    this.save();
    this.removeOwnedImages(removed);
  }

  removeOwnedImages(question) {
    if (question.image) this.removeImage(question.image);
    question.answers.forEach((a) => a.image && this.removeImage(a.image));
  }

  select(ids) {
    if (!Array.isArray(ids)) throw new ValidationError('Selection must be a list of question ids.');
    const wanted = new Set(ids);
    for (const q of this.questions) q.selected = wanted.has(q.id);
    this.save();
  }

  exportPack() {
    const read = (name) => fs.readFileSync(path.join(this.uploadDir, name)).toString('base64');
    return {
      version: 1,
      questions: this.questions.map((q) => ({
        kind: q.kind,
        text: q.text,
        difficulty: q.difficulty,
        order: q.order,
        answers: q.answers.map((a) => ({ text: a.text, ...(a.image ? { imageData: read(a.image) } : {}) })),
        correctIndex: q.correctIndex,
        correctText: q.correctText,
        reason: q.reason,
        alt: q.alt,
        selected: q.selected,
        ...(q.image ? { imageData: read(q.image) } : {}),
      })),
    };
  }

  importPack(pack) {
    if (!pack || pack.version !== 1 || !Array.isArray(pack.questions)) {
      throw new ValidationError('That file is not a question pack.');
    }
    const written = [];
    try {
      const imported = pack.questions.map((item) => {
        const fields = cleanFields(item);
        if (!fields.text && !item.imageData) throw new ValidationError(NEEDS_PROMPT);
        const resolved = this.resolveAnswers(fields.answers);
        written.push(...resolved.written);
        let image = null;
        if (item.imageData) {
          image = this.writeImage(Buffer.from(String(item.imageData), 'base64'));
          written.push(image);
        }
        return { id: crypto.randomUUID(), image, selected: item.selected === true, ...fields, answers: resolved.answers };
      });
      const old = this.questions;
      this.questions = imported;
      this.save();
      old.forEach((q) => this.removeOwnedImages(q));
    } catch (error) {
      for (const name of written) this.removeImage(name);
      throw error;
    }
  }
}

module.exports = { Store, ValidationError };

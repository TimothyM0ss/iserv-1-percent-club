'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MAX_ANSWER_LENGTH = 120;
const MAX_REASON_LENGTH = 600;
const MAX_ALT_LENGTH = 300;

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
  const answers = Array.isArray(data.answers) ? data.answers.map((a) => String(a ?? '').trim()) : [];
  if (answers.length < 3 || answers.length > 4 || answers.some((a) => !a || a.length > MAX_ANSWER_LENGTH)) {
    throw new ValidationError(`Provide 3 or 4 answers, each 1 to ${MAX_ANSWER_LENGTH} characters.`);
  }
  const correctIndex = Number(data.correctIndex);
  if (!Number.isInteger(correctIndex) || correctIndex < 0 || correctIndex >= answers.length) {
    throw new ValidationError('Mark exactly one answer as correct.');
  }
  const reason = String(data.reason ?? '').trim();
  if (!reason || reason.length > MAX_REASON_LENGTH) {
    throw new ValidationError(`Explain why the answer is correct (up to ${MAX_REASON_LENGTH} characters).`);
  }
  const alt = String(data.alt ?? '').trim().slice(0, MAX_ALT_LENGTH);
  return { difficulty, order, answers, correctIndex, reason, alt };
}

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
      this.questions = JSON.parse(fs.readFileSync(this.file, 'utf8'));
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
      .map((q) => ({ ...q, imageUrl: `/uploads/${q.image}` }));
  }

  get selectedCount() {
    return this.questions.filter((q) => q.selected).length;
  }

  gameQuestions() {
    return this.list()
      .filter((q) => q.selected)
      .map(({ id, imageUrl, alt, answers, correctIndex, reason, difficulty }) => ({
        id,
        imageUrl,
        alt,
        answers,
        correctIndex,
        reason,
        difficulty,
      }));
  }

  writeImage(buffer) {
    const extension = sniffImageExtension(buffer ?? Buffer.alloc(0));
    if (!extension) throw new ValidationError('The image must be a PNG, JPEG, GIF or WebP file.');
    const name = `${crypto.randomUUID()}.${extension}`;
    fs.writeFileSync(path.join(this.uploadDir, name), buffer);
    return name;
  }

  removeImage(name) {
    fs.rmSync(path.join(this.uploadDir, path.basename(name)), { force: true });
  }

  add(input, imageBuffer) {
    const fields = cleanFields(input);
    if (!imageBuffer) throw new ValidationError('Upload an image for the question.');
    const question = { id: crypto.randomUUID(), image: this.writeImage(imageBuffer), selected: false, ...fields };
    this.questions.push(question);
    this.save();
    return question;
  }

  update(id, input, imageBuffer) {
    const question = this.questions.find((q) => q.id === id);
    if (!question) throw new ValidationError('Question not found.');
    const fields = cleanFields(input);
    const previousImage = question.image;
    if (imageBuffer) question.image = this.writeImage(imageBuffer);
    Object.assign(question, fields);
    this.save();
    if (imageBuffer) this.removeImage(previousImage);
    return question;
  }

  remove(id) {
    const index = this.questions.findIndex((q) => q.id === id);
    if (index === -1) throw new ValidationError('Question not found.');
    const [removed] = this.questions.splice(index, 1);
    this.save();
    this.removeImage(removed.image);
  }

  select(ids) {
    if (!Array.isArray(ids)) throw new ValidationError('Selection must be a list of question ids.');
    const wanted = new Set(ids);
    for (const q of this.questions) q.selected = wanted.has(q.id);
    this.save();
  }

  exportPack() {
    return {
      version: 1,
      questions: this.questions.map((q) => ({
        difficulty: q.difficulty,
        order: q.order,
        answers: q.answers,
        correctIndex: q.correctIndex,
        reason: q.reason,
        alt: q.alt,
        selected: q.selected,
        imageData: fs.readFileSync(path.join(this.uploadDir, q.image)).toString('base64'),
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
        const image = this.writeImage(Buffer.from(String(item.imageData ?? ''), 'base64'));
        written.push(image);
        return { id: crypto.randomUUID(), image, selected: item.selected === true, ...fields };
      });
      const old = this.questions;
      this.questions = imported;
      this.save();
      for (const q of old) this.removeImage(q.image);
    } catch (error) {
      for (const name of written) this.removeImage(name);
      throw error;
    }
  }
}

module.exports = { Store, ValidationError };

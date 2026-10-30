'use strict';

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, value);
  }
  el.append(...children.flat().filter((child) => child != null && child !== false));
  return el;
}

function questionPrompt(question, number) {
  return h('div', { class: 'q-prompt' },
    question.text && h('p', { class: 'q-text' }, question.text),
    question.imageUrl && h('img', { class: 'q-img', src: question.imageUrl, alt: question.alt || `Question ${number}`, decoding: 'async', fetchpriority: 'high' }));
}

const formatNumber = (n) => Number(n).toLocaleString('en-GB');

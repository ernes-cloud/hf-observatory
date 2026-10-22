// Page-level building blocks shared by every section: a header that says what
// the page is for, key takeaways in plain English, and a "how to read" note.

import { esc } from './format.js';

/**
 * pageHeader({ id, eyebrow, title, lead, takeaways: [{value, text}], howTo: [html] })
 * `lead` and takeaway `text` may contain trusted HTML (glossary terms, <strong>).
 */
export function pageHeader({ id, eyebrow, title, lead, takeaways = [], howTo = [], note = '' }) {
  const el = document.createElement('header');
  el.className = 'page-head';
  el.innerHTML = `
    ${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ''}
    <h1 id="${id}">${esc(title)}</h1>
    ${lead ? `<p class="lead">${lead}</p>` : ''}
    ${note}
    ${takeaways.length ? `
      <section class="takeaways" aria-label="Key takeaways">
        <h2 class="takeaways-title">Key takeaways</h2>
        <ul>${takeaways.map((t) => `<li><span class="tk-value">${esc(t.value)}</span><span class="tk-text">${t.text}</span></li>`).join('')}</ul>
      </section>` : ''}
    ${howTo.length ? `
      <details class="how-to">
        <summary>How to read this page</summary>
        <ul>${howTo.map((h) => `<li>${h}</li>`).join('')}</ul>
      </details>` : ''}`;
  return el;
}

/** A titled group of cards, so long pages read as chapters. */
export function sectionTitle(title, sub = '') {
  const el = document.createElement('div');
  el.className = 'section-title span-12';
  el.innerHTML = `<h2>${esc(title)}</h2>${sub ? `<p>${sub}</p>` : ''}`;
  return el;
}

/** What the numbers cover: the radar is a curated selection, not a mirror of the Hub. */
export function coverageNote(meta, { noise } = {}) {
  const start = meta?.tracking_start ? new Date(`${meta.tracking_start}T00:00:00Z`) : null;
  const since = start ? start.toLocaleDateString('en', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : 'mid-2026';
  return `<aside class="coverage" aria-label="What the data covers">
    <strong>What these numbers cover.</strong> The site follows the ${meta?.models ? Number(meta.models).toLocaleString('en') : ''} models
    tracked by <a href="https://radar-huggingface.686f6c61.dev" rel="noopener">HF//RADAR</a>, a curated selection of what trends on
    Hugging Face, not every model on the Hub. Tracking began on ${esc(since)}: older models appear only when the radar picked them up
    later, so growth over time partly reflects the radar adding models.${noise ? ` Counts leave out ${Number(noise).toLocaleString('en')}
    low-signal uploads (experiment checkpoints, course exercises, test repos and uploads with no downloads or likes after a week).` : ''}
    <a href="#about">How the data is cleaned →</a></aside>`;
}

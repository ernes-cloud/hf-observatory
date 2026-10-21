// Page-level building blocks shared by every section: a header that says what
// the page is for, key takeaways in plain English, and a "how to read" note.

import { esc } from './format.js';

/**
 * pageHeader({ id, eyebrow, title, lead, takeaways: [{value, text}], howTo: [html] })
 * `lead` and takeaway `text` may contain trusted HTML (glossary terms, <strong>).
 */
export function pageHeader({ id, eyebrow, title, lead, takeaways = [], howTo = [] }) {
  const el = document.createElement('header');
  el.className = 'page-head';
  el.innerHTML = `
    ${eyebrow ? `<p class="eyebrow">${esc(eyebrow)}</p>` : ''}
    <h1 id="${id}">${esc(title)}</h1>
    ${lead ? `<p class="lead">${lead}</p>` : ''}
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

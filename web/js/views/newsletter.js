import { load } from '../data.js';
import { pageHeader } from '../ui.js';
import { stats } from '../charts.js';
import { authorUrl, compact, date, esc, hfUrl, int, LICENSE_FAMILY, params as fmtParams, pct, task } from '../format.js';

let idx = null;
let els = null;

export async function render(section, params) {
  idx = await load('newsletter/index.json');
  section.replaceChildren(pageHeader({
    id: 'h-newsletter', eyebrow: 'Newsletter', title: 'The week on Hugging Face',
    lead: 'A short report written automatically every week: the most notable new models, what grew, what shrank and what was deleted.',
    howTo: [
      'Weekly issues run Monday to Monday and never change once published. “Last 7 days” is refreshed with every update.',
      'Pick an older issue from the list to read past weeks.',
      'Copy as Markdown pastes the issue into an email, Slack or a blog. There is also an <a href="data/newsletter/feed.xml">RSS feed</a> for feed readers.',
    ],
  }));
  section.insertAdjacentHTML('beforeend', '<div id="nl-body"></div>');
  const body = section.querySelector('#nl-body');
  if (!idx.issues.length) {
    body.innerHTML = '<div class="empty">No issues yet. The newsletter needs two dataset releases a week apart.</div>';
    return;
  }
  body.innerHTML = `
    <div class="issue-picker">
      <div class="field"><label for="nl-pick">Issue</label>
        <select id="nl-pick">${idx.issues.map((i) => `<option value="${esc(i.slug)}">${esc(i.title)}</option>`).join('')}</select></div>
      <a class="btn" id="nl-md" download>Download Markdown</a>
      <button type="button" class="btn" id="nl-copy">Copy as Markdown</button>
      <span class="note" id="nl-copied" role="status" aria-live="polite"></span>
    </div>
    <article class="card issue" id="nl-issue"></article>`;
  els = { pick: body.querySelector('#nl-pick'), md: body.querySelector('#nl-md'), copy: body.querySelector('#nl-copy'), copied: body.querySelector('#nl-copied'), issue: body.querySelector('#nl-issue') };
  els.pick.addEventListener('change', () => show(els.pick.value, true));
  els.copy.addEventListener('click', async () => {
    try {
      const d = await load(`newsletter/${els.pick.value}.json`);
      await navigator.clipboard.writeText(d.markdown);
      els.copied.textContent = 'Copied.';
    } catch (e) {
      els.copied.textContent = 'Copy failed: use Download instead.';
    }
    setTimeout(() => { els.copied.textContent = ''; }, 2500);
  });
  const want = params.get('issue');
  await show(idx.issues.some((i) => i.slug === want) ? want : idx.issues[0].slug, false);
}

export function update(section, params) {
  const want = params.get('issue');
  if (els && want && want !== els.pick.value && idx.issues.some((i) => i.slug === want)) show(want, false);
}

const modelLink = (id) => `<a href="${esc(hfUrl(id))}" rel="noopener">${esc(id)}</a>`;
const meta = (m) => [m.task ? task(m.task) : null, fmtParams(m.parameters ? m.parameters / 1e6 : null)].filter(Boolean).join(', ');

async function show(slug, push) {
  els.pick.value = slug;
  els.md.href = `data/newsletter/${slug}.md`;
  els.md.setAttribute('download', `hf-observatory-${slug}.md`);
  if (push) history.replaceState(null, '', `#newsletter?issue=${slug}`);
  const d = await load(`newsletter/${slug}.json`);
  const s = d.stats;
  const net = s.live_now - s.live_before;
  const e = els.issue;
  e.innerHTML = `
    <h2 style="border:0;margin-top:0;padding-top:0">${esc(d.title)}</h2>
    <p class="issue-meta">Comparing release ${esc(d.from_tag)} (${esc(date(d.from))}) with ${esc(d.to_tag)} (${esc(date(d.to))})</p>
    ${d.intro.map((p) => `<p>${esc(p)}</p>`).join('')}
    <div id="nl-stats"></div>
    ${block('Top new models', 'Created on the Hub during the week, by downloads so far', d.top_new.length ? `<ol>${d.top_new.map((m) => `<li>${modelLink(m.id)}${meta(m) ? ` <span class="note">(${esc(meta(m))})</span>` : ''}: ${compact(m.downloads)} downloads, ${int(m.likes)} like${m.likes === 1 ? '' : 's'}, ${esc(LICENSE_FAMILY[m.lf]?.label.toLowerCase() || m.lf)}</li>`).join('')}</ol>` : '')}
    ${block('Most liked newcomers', '', d.liked_new.length ? `<ul>${d.liked_new.map((m) => `<li>${modelLink(m.id)}: ${int(m.likes)} likes</li>`).join('')}</ul>` : '')}
    ${block('Notable moves', 'Biggest changes in 30-day downloads among models tracked a week earlier', d.rising.length ? `
      <h3>Gaining</h3><ul>${d.rising.map((m) => `<li>${modelLink(m.id)}: ${compact(m.old)} → ${compact(m.new)} <strong class="delta up">+${compact(m.delta)}</strong></li>`).join('')}</ul>
      ${d.fading.length ? `<h3>Dropping</h3><ul>${d.fading.map((m) => `<li>${modelLink(m.id)}: ${compact(m.old)} → ${compact(m.new)} <strong class="delta down">−${compact(Math.abs(m.delta))}</strong></li>`).join('')}</ul>` : ''}` : '')}
    ${block('Removals', `Models that started returning 404 during the week${s.removed_cleanup != null ? `. Not listed: ${int(s.removed_cleanup)} experiments nobody used and ${int(s.removed_replaced)} uploads replaced by a newer version` : ''}`, d.removals.length ? `<ul>${d.removals.map((m) => `<li>${esc(m.id)}: ${compact(m.downloads)} downloads before removal${m.gated ? ', gated' : ''}${m.lf === 'unknown' ? ', license not declared' : ''}${m.kind === 'rehosted' && m.successor ? `; the same name is still live at ${modelLink(m.successor)}` : ''}</li>`).join('')}</ul>
      ${d.removers.length ? `<p>Publishers removing the most: ${d.removers.map((r) => `${esc(r.author)} (${int(r.models)})`).join(', ')}.</p>` : ''}` : '')}
    ${block('Most active publishers', 'By new models created during the week that drew downloads or likes (experiment sweeps and test uploads left out)', d.publishers.length ? `<ul>${d.publishers.map((p) => `<li><a href="${esc(authorUrl(p.author))}" rel="noopener">${esc(p.author)}</a>: ${int(p.models)} new model${p.models === 1 ? '' : 's'}</li>`).join('')}</ul>` : '')}
    ${block('New models by family and task', '', d.families.length ? `<p>${d.families.map((f) => `${esc(f.family)} ${int(f.models)}`).join(' · ')}</p>${d.tasks.length ? `<p class="note">Top tasks: ${d.tasks.map((t) => `${esc(task(t.task))} ${int(t.models)}`).join(' · ')}</p>` : ''}` : '')}
    <p class="note" style="margin-top:24px">Generated automatically from <a href="https://github.com/686f6c61/radar-huggingface-dataset">radar-huggingface-dataset</a> (CC-BY-4.0).</p>`;
  e.querySelector('#nl-stats').append(stats([
    { label: 'New models created', value: int(s.created), sub: `${int(s.newly_tracked)} newly tracked in total` },
    { label: 'Removed', value: int(s.removed), sub: 'detected during the week' },
    { label: 'Live models tracked', value: int(s.live_now), sub: `${net >= 0 ? '+' : '−'}${int(Math.abs(net))} over the week` },
    { label: 'Open source', value: s.fresh_open_share == null ? '–' : pct(s.fresh_open_share), sub: s.fresh_conditional_share != null ? `of the new models; ${pct(s.fresh_conditional_share)} under custom terms` : 'of the new models' },
  ]));
}

function block(title, sub, html) {
  if (!html) return '';
  return `<h2>${esc(title)}</h2>${sub ? `<p class="note">${esc(sub)}</p>` : ''}${html}`;
}

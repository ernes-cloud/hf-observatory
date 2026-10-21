import { load } from '../data.js';
import { compact, esc, int, pct } from '../format.js';
import { glossaryHtml, term } from '../glossary.js';

const ICONS = {
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  tree: '<circle cx="12" cy="5" r="2.5"/><circle cx="5" cy="19" r="2.5"/><circle cx="19" cy="19" r="2.5"/><path d="M12 7.5v4M12 11.5L5 16.5M12 11.5l7 5"/>',
  archive: '<rect x="3" y="4" width="18" height="5" rx="1"/><path d="M5 9v10h14V9M10 13h4"/>',
  chip: '<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>',
};
const icon = (k) => `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${ICONS[k]}</svg>`;

async function optional(name) {
  try { return await load(name); } catch (e) { return null; }
}

export async function render(section) {
  const [ov, tr, fam, nl] = await Promise.all([load('overview.json'), optional('trends.json'), optional('families/index.json'), optional('newsletter/index.json')]);
  const t = ov.totals;
  const w7 = tr?.windows?.['7'] || tr?.windows?.[Object.keys(tr?.windows || {})[0]];
  const riser = w7?.rising?.[0];
  const topBase = fam?.bases?.[0];
  const issue = nl?.issues?.[0];
  const issueFull = issue ? await optional(`newsletter/${issue.slug}.json`) : null;
  const topPub = ov.top_orgs_by_downloads[0];
  const topFam = ov.families.find((f) => f.family !== 'BERT-style') || ov.families[0];

  const tasks = [
    { href: '#advisor', icon: 'chip', title: 'Get a recommendation for my hardware', text: 'Say what you will use it for (chat, coding, agents…) and which GPU or Mac you have. Get the models that fit and the command to run them.', fact: 'Ollama, LM Studio, llama.cpp, MLX or vLLM' },
    { href: '#finder', icon: 'search', title: 'Find a model for my project', text: 'Filter by what you need it for, language, license and how much memory your computer has.', fact: `${int(t.live)} models to search` },
    { href: '#overview', icon: 'chart', title: 'Get the big picture', text: 'Who publishes the most, which tasks dominate, which licenses and file formats are common.', fact: topPub ? `${esc(topPub.author)} leads with ${compact(topPub.downloads)} downloads a month` : '' },
    { href: '#trends', icon: 'trend', title: 'See what is rising and fading', text: 'Which models and publishers gained or lost downloads over the last 7, 14 or 30 days.', fact: riser ? `Biggest riser: ${esc(riser.id)} (+${compact(riser.delta)})` : '' },
    { href: '#families', icon: 'tree', title: 'Explore model families', text: 'Most models are built on another one. See which base models spawn the most copies and variants.', fact: topBase ? `${esc(topBase.id)} has ${int(topBase.direct)} direct derivatives` : '' },
    { href: '#graveyard', icon: 'archive', title: 'See which models were deleted', text: 'Models that disappeared from Hugging Face: who removes them and how long they lasted.', fact: `${int(t.removed)} removed; half lasted under ${Math.max(1, Math.round(t.removed_median_days || 0))} days` },
    { href: '#newsletter', icon: 'mail', title: 'Read this week’s summary', text: 'A short weekly report on new models, removals and notable moves, written automatically.', fact: issue ? esc(issue.title) : '' },
  ];

  section.innerHTML = `
    <div class="hero">
      <p class="eyebrow">Hugging Face model ecosystem · updated daily</p>
      <h1 id="h-home">Make sense of the open AI models on Hugging Face</h1>
      <p class="lead">Hugging Face is the main place where open AI models are published. This site follows
      ${int(t.tracked)} of them every day and turns the raw numbers into answers: which model suits your project,
      what is gaining popularity, who builds on whom, and what disappeared.</p>
      <div class="hero-actions">
        <a class="btn btn-primary" href="#advisor">Get a model recommendation</a>
        <a class="btn btn-ghost" href="#finder">Search all models</a>
        <a class="btn btn-ghost" href="#overview">See the big picture</a>
      </div>
    </div>

    <section aria-labelledby="h-numbers" class="home-block">
      <h2 id="h-numbers" class="block-title">The ecosystem today</h2>
      <div class="stats">
        <div class="stat"><div class="stat-label">Live ${term('model', 'models')} tracked</div><div class="stat-value">${int(t.live)}</div><div class="stat-sub">from ${int(t.authors)} ${term('publisher', 'publishers')}</div></div>
        <div class="stat"><div class="stat-label">${term('downloads', 'Downloads in the last 30 days')}</div><div class="stat-value">${compact(t.downloads_30d)}</div><div class="stat-sub">across all live models</div></div>
        <div class="stat"><div class="stat-label">New in the last 7 days</div><div class="stat-value">${int(t.created_7d)}</div><div class="stat-sub">models created on the Hub</div></div>
        <div class="stat"><div class="stat-label">Allow commercial use</div><div class="stat-value">${pct(t.open_license / t.live)}</div><div class="stat-sub">of live models have an open ${term('license', 'license')}</div></div>
      </div>
    </section>

    <section aria-labelledby="h-do" class="home-block">
      <h2 id="h-do" class="block-title">What do you want to do?</h2>
      <div class="task-grid">
        ${tasks.map((k) => `
          <a class="task-card" href="${k.href}">
            <span class="task-icon">${icon(k.icon)}</span>
            <span class="task-body">
              <span class="task-title">${k.title}</span>
              <span class="task-text">${k.text}</span>
              ${k.fact ? `<span class="task-fact">${k.fact}</span>` : ''}
            </span>
          </a>`).join('')}
      </div>
    </section>

    ${issue ? `
    <section aria-labelledby="h-week" class="home-block">
      <h2 id="h-week" class="block-title">This week in one paragraph</h2>
      <div class="card week-card">
        <p>${esc(issueFull ? issueFull.intro.join(' ') : issue.summary)}</p>
        <p class="note">From the newsletter issue “${esc(issue.title)}”. <a href="#newsletter">Read the full summary →</a></p>
      </div>
    </section>` : ''}

    <section aria-labelledby="h-insights" class="home-block">
      <h2 id="h-insights" class="block-title">Three things worth knowing</h2>
      <div class="insight-grid">
        <div class="insight"><span class="tk-value">${pct(t.derived / t.live)}</span><p>of live models are built on top of another model (${term('finetune', 'fine-tunes')}, ${term('quantization', 'quantizations')}, ${term('adapter', 'adapters')}…). Very few are trained from scratch.</p></div>
        <div class="insight"><span class="tk-value">${topFam ? esc(topFam.family) : '–'}</span><p>is the most downloaded ${term('family', 'family')} of language models${topFam ? `, with ${compact(topFam.downloads)} downloads a month across ${int(topFam.models)} models` : ''}.</p></div>
        <div class="insight"><span class="tk-value">${pct(t.removed_within_week)}</span><p>of the models that were deleted lasted less than a week on Hugging Face. Many are experiments uploaded and withdrawn quickly.</p></div>
      </div>
    </section>

    <section aria-labelledby="h-terms" class="home-block">
      <h2 id="h-terms" class="block-title">Words you will see</h2>
      <div class="card">
        ${glossaryHtml(['downloads', 'parameters', 'license', 'gguf', 'quantization', 'finetune'])}
        <p class="note"><a href="#about">Full glossary and data sources →</a> Underlined terms anywhere on the site show their definition when you hover or tap them.</p>
      </div>
    </section>
`;
}

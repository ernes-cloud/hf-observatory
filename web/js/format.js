// English (en-US) number, date and label formatting shared by every view.

const LOCALE = 'en-US';
const intFmt = new Intl.NumberFormat(LOCALE);
const compactFmt = new Intl.NumberFormat(LOCALE, { notation: 'compact', maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat(LOCALE, { style: 'percent', maximumFractionDigits: 1 });
const dateFmt = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
const shortDateFmt = new Intl.DateTimeFormat(LOCALE, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateTimeFmt = new Intl.DateTimeFormat(LOCALE, { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' });
let langNames = null;
try { langNames = new Intl.DisplayNames([LOCALE], { type: 'language' }); } catch (e) { /* old browser */ }

export const int = (n) => (n == null ? '–' : intFmt.format(n));
export const compact = (n) => (n == null ? '–' : compactFmt.format(n));
export const pct = (x) => (x == null || !isFinite(x) ? '–' : pctFmt.format(x));
export const signed = (n, f = compact) => (n == null ? '–' : (n > 0 ? '+' : n < 0 ? '−' : '') + f(Math.abs(n)));
export const signedPct = (x) => (x == null || !isFinite(x) ? '–' : (x > 0 ? '+' : x < 0 ? '−' : '') + pctFmt.format(Math.abs(x)));

const toDate = (d) => (d instanceof Date ? d : new Date(typeof d === 'number' ? d : String(d).length === 10 ? d + 'T00:00:00Z' : d));
export const date = (d) => (d ? dateFmt.format(toDate(d)) : '–');
export const shortDate = (d) => (d ? shortDateFmt.format(toDate(d)) : '–');
export const dateTime = (d) => (d ? dateTimeFmt.format(toDate(d)) : '–');

/** Parameters given in millions → "7.6B", "350M". */
export function params(millions) {
  if (millions == null) return null;
  if (millions >= 999.5) {
    const b = millions / 1000;
    return (b >= 100 ? Math.round(b) : b >= 10 ? b.toFixed(1).replace(/\.0$/, '') : b.toFixed(2).replace(/0$/, '').replace(/\.0$/, '')) + 'B';
  }
  if (millions >= 1) return Math.round(millions) + 'M';
  return Math.max(1, Math.round(millions * 1000)) + 'K';
}

export function gigabytes(gb) {
  if (gb == null) return null;
  if (gb < 1) return `${Math.max(0.1, gb).toFixed(1)} GB`;
  return `${gb < 10 ? gb.toFixed(1) : Math.round(gb)} GB`;
}

export function days(n) {
  if (n == null) return '–';
  if (n < 1) return 'under a day';
  if (n < 60) return `${Math.round(n)} day${Math.round(n) === 1 ? '' : 's'}`;
  if (n < 730) return `${Math.round(n / 30.4)} months`;
  return `${(n / 365).toFixed(1)} years`;
}

/** "text-generation" → "Text generation". */
export function task(tag) {
  if (!tag || tag === 'unspecified') return 'Unspecified task';
  const special = { 'any-to-any': 'Any-to-any', 'text2text-generation': 'Text-to-text generation' };
  if (special[tag]) return special[tag];
  const s = tag.replace(/-/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function language(code) {
  if (!code) return '';
  if (code === 'multilingual') return 'Multilingual';
  try {
    const name = langNames && langNames.of(code);
    if (name && name.toLowerCase() !== code.toLowerCase()) return name;
  } catch (e) { /* invalid code */ }
  return code;
}

export const LICENSE_FAMILY = {
  oss: { label: 'Open source', long: 'Open-source license (commercial use allowed)', short: 'Commercial OK' },
  conditional: { label: 'Open with conditions', long: 'Custom license (Llama, Gemma, OpenRAIL…): commercial use usually allowed, with conditions', short: 'Conditions apply' },
  'non-commercial': { label: 'Non-commercial', long: 'Non-commercial or research-only license', short: 'Non-commercial' },
  unknown: { label: 'Not declared', long: 'License missing, “other” or ambiguous', short: 'License unclear' },
};
export const LF_COLOR = { oss: 'var(--series-1)', conditional: 'var(--series-3)', 'non-commercial': 'var(--series-2)', unknown: 'var(--axis)' };
export const LF_ORDER = ['oss', 'conditional', 'non-commercial', 'unknown'];

/** Why a model left the Hub, as far as the data can tell (pipeline/hfo/quality.py). */
export const REMOVAL_KIND = {
  removed: { label: 'Removed', long: 'Deleted or made private, with no replacement in sight' },
  replaced: { label: 'Replaced', long: 'The same publisher uploaded a near-identical name around the same time (a new version)' },
  rehosted: { label: 'Same name elsewhere', long: 'A repository with the same name is live under another account (a mirror, a re-upload or the original)' },
  cleanup: { label: 'Unused experiment', long: 'Never had downloads or likes: clean-up of tests and experiments' },
};

export const FORMAT_LABEL = { gguf: 'GGUF', mlx: 'MLX', onnx: 'ONNX', safetensors: 'safetensors', diffusers: 'Diffusers' };

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export const hfUrl = (id) => `https://huggingface.co/${id.split('/').map(encodeURIComponent).join('/')}`;
export const authorUrl = (a) => `https://huggingface.co/${encodeURIComponent(a)}`;

// Internal pages: every model, publisher and family name on the site links here first.
export const modelHref = (id) => `#model?id=${encodeURIComponent(id)}`;
export const orgHref = (a) => `#org?name=${encodeURIComponent(a)}`;
export const familyHref = (f) => `#family?name=${encodeURIComponent(f)}`;
export const finderHref = (params) => `#finder?${new URLSearchParams(params)}`;
/** A model name as an internal link, the publisher part muted. */
export function modelLink(id, { short = false } = {}) {
  const [author, ...rest] = String(id).split('/');
  const name = rest.length ? `${short ? '' : `<span class="author">${esc(author)}/</span>`}${esc(rest.join('/'))}` : esc(id);
  return `<a href="${esc(modelHref(id))}" title="${esc(id)}">${name}</a>`;
}

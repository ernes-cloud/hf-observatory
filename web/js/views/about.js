import { load } from '../data.js';
import { dateTime, esc, int } from '../format.js';
import { glossaryHtml } from '../glossary.js';

// English version of the dataset's SCHEMA.md (the original is in Spanish).
const FIELDS = [
  ['id', 'Full Hugging Face id (author/model).'],
  ['author', 'Organization or user that publishes the model.'],
  ['created_at / updated_at', 'Creation and last-modification dates on the Hub.'],
  ['license', 'License as declared on the model card (raw).'],
  ['license_family', 'The dataset’s own classification: oss (open license, commercial use allowed), non-commercial, or unknown (missing, “other” or ambiguous).'],
  ['pipeline_tag', 'Main task, e.g. text-generation.'],
  ['library', 'Library the model targets (transformers, gguf, diffusers…).'],
  ['languages', 'Languages declared on the model card.'],
  ['likes', 'Total likes.'],
  ['downloads_30d', 'Downloads in the last 30 days, as published by Hugging Face (a rolling window).'],
  ['trending_score', 'Last known Hugging Face trending score (0 if it never trended).'],
  ['parameters', 'Real parameter count read from safetensors or GGUF metadata; empty when the Hub does not compute it.'],
  ['storage_bytes', 'Repository size in bytes.'],
  ['base_model', 'Base model(s) declared on the model card. Combined with Hub tags it tells whether a model is a fine-tune, quantization, adapter or merge.'],
  ['formats', 'Distribution formats derived from the files: gguf, mlx, onnx, safetensors, diffusers.'],
  ['is_conversational', 'Hub “conversational” tag (chat / instruction models).'],
  ['gated', 'Access is restricted on the Hub (you must accept terms or request access).'],
  ['removed / removed_at', 'The model returned a real 404 on the Hub, and when that was detected. Removed models are never deleted from the dataset.'],
  ['benchmarks', 'Metrics from the model-index: task, dataset, metric, value. Empty means “not captured”, not “no benchmarks”.'],
];

export async function render(section) {
  let meta = null;
  try { meta = await load('meta.json'); } catch (e) { /* shown in footer */ }
  section.innerHTML = `
    <div class="prose">
      <p class="eyebrow">Help</p>
      <h1 id="h-about">Help &amp; glossary</h1>
      <p class="lead">HF Observatory explains the open AI models published on <a href="https://huggingface.co">Hugging Face</a>:
      which ones exist, which are used, how they relate to each other and which disappear. Everything is rebuilt daily from an open dataset.</p>
      <h2>Where to start</h2>
      <ul>
        <li><a href="#finder"><strong>Find a model</strong></a> if you need a model for a project: start with a quick preset, then refine.</li>
        <li><a href="#overview"><strong>Overview</strong></a> for the big picture: publishers, tasks, sizes, formats and licenses.</li>
        <li><a href="#trends"><strong>Trends</strong></a> to see what is gaining or losing popularity.</li>
        <li><a href="#families"><strong>Family trees</strong></a> to see which base models others build on.</li>
        <li><a href="#graveyard"><strong>Graveyard</strong></a> for models that were deleted.</li>
        <li><a href="#newsletter"><strong>Newsletter</strong></a> for a weekly summary in plain English.</li>
      </ul>
      <p>Every chart has a <strong>Table</strong> button with the exact numbers, and underlined terms show a definition when you hover or tap them.</p>
      <h2 id="glossary">Glossary</h2>
    </div>
    ${glossaryHtml()}
    <div class="prose">
      <h2>About the data</h2>
      <p>HF Observatory is built entirely on <a href="https://github.com/686f6c61/radar-huggingface-dataset">radar-huggingface-dataset</a>,
      an open, versioned dataset of the Hugging Face model ecosystem produced by <a href="https://radar-huggingface.686f6c61.dev">HF//RADAR</a>
      and published under the <a href="https://creativecommons.org/licenses/by/4.0/">Creative Commons Attribution 4.0 (CC-BY-4.0)</a> license.
      The underlying metadata comes from the <a href="https://huggingface.co">Hugging Face Hub</a>.</p>
      ${meta ? `<p>Current snapshot: <strong>${esc(dateTime(meta.snapshot_at))}</strong>, ${int(meta.models)} models tracked${meta.release ? `, release <code>${esc(meta.release)}</code>` : ''}.</p>` : ''}
      <h2>What the dataset is</h2>
      <p>The radar exports its database about three times a day. Each export is published as an immutable, numbered GitHub release
      (<code>v14.2.1</code> is the night export of day 14), and a floating <code>latest</code> release always holds the most recent bulk file.
      It is a <em>curated</em> layer, not a mirror of the Hub: it focuses on models with enough information to be useful, and keeps
      models that disappear from the Hub flagged as removed instead of deleting them.</p>
      <p>Every model in the dataset also has a technical model card written in Spanish by the radar. This site does not reproduce those cards;
      the short English descriptions in the model finder are generated from the structured metadata below.</p>
      <h2>Dataset fields (translated from the original Spanish schema)</h2>
      <dl>${FIELDS.map(([k, v]) => `<dt><code>${esc(k)}</code></dt><dd>${esc(v)}</dd>`).join('')}</dl>
      <h2>How this site uses it</h2>
      <p>A Python + DuckDB pipeline downloads the latest bulk file and a series of past releases, aggregates them into small JSON files and
      publishes the static site on GitHub Pages. A scheduled GitHub Actions workflow repeats this every day.
      Download figures are rolling 30-day windows, so a change between two snapshots compares two overlapping windows.
      Memory estimates in the finder are rough: parameters × bytes per parameter plus 15%.</p>
      <h2>Caveats</h2>
      <ul>
        <li>The radar started in August 2026; anything before that is reconstructed from creation dates and under-represents older models.</li>
        <li>The model population grows over time as the radar tracks more models, so totals across snapshots are not like-for-like.</li>
        <li>License classification and family detection are heuristic. Always check the original model card before using a model in production.</li>
      </ul>
    </div>`;
}

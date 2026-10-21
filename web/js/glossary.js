// Plain-English definitions for the jargon used across the site.
// `term('gguf')` renders an inline, focusable term that shows its definition on hover, focus or tap.

import { esc } from './format.js';

export const GLOSSARY = {
  model: ['Model', 'A trained AI system published on Hugging Face, such as a chatbot, an image generator or a speech recogniser. Each one has a page with its files and documentation.'],
  publisher: ['Publisher', 'The organization or person who uploaded the model to Hugging Face (the part before the “/” in a model name, e.g. “Qwen” in Qwen/Qwen3-8B).'],
  downloads: ['Downloads (30 days)', 'How many times the model was downloaded in the last 30 days, as reported by Hugging Face. It is a rolling window, so it reflects current popularity rather than all-time totals.'],
  likes: ['Likes', 'Hearts given by Hugging Face users. A rough signal of how much the community values a model.'],
  trending: ['Trending score', 'Hugging Face’s own measure of how fast a model is gaining attention right now. 0 means it never appeared in the trending list.'],
  task: ['Task', 'What the model is for, such as text generation (chatbots), speech recognition or image generation. Declared by the author.'],
  parameters: ['Parameters', 'The number of learned values inside a model, a proxy for its size. “7B” means 7 billion. Bigger models are usually more capable but need more memory.'],
  memory: ['Estimated memory', 'Roughly how much GPU or unified memory you need to load the model: parameters × bytes per parameter (2 for 16-bit, about 1 for 8-bit, about 0.6 for 4-bit and GGUF), plus 15%. Long conversations need more.'],
  license: ['License', 'The legal terms for using the model. “Open license” means commercial use is allowed (Apache-2.0, MIT…). “Non-commercial” forbids business use. “Unclear” means it is missing or ambiguous: check before using it in a product.'],
  gated: ['Gated', 'The author requires you to accept terms or request access on Hugging Face before downloading.'],
  removed: ['Removed', 'The model page no longer exists on Hugging Face (it returns a “404 not found”). The dataset keeps a record of it.'],
  gguf: ['GGUF', 'A single-file format for running models locally with llama.cpp, Ollama or LM Studio, usually compressed (quantized) to fit on a laptop.'],
  mlx: ['MLX', 'Apple’s framework for running models efficiently on Apple Silicon Macs (M1–M4).'],
  onnx: ['ONNX', 'A portable format for running models in many runtimes, including browsers and mobile devices.'],
  safetensors: ['safetensors', 'The standard, safe file format for model weights on Hugging Face, used by the Transformers library.'],
  diffusers: ['Diffusers', 'Hugging Face’s library and format for image and video generation models.'],
  basemodel: ['Base model', 'The model another one was built from. Fine-tunes, quantizations, adapters and merges all declare a base model.'],
  finetune: ['Fine-tune', 'A copy of a base model trained further on new data to specialise it (for a language, a domain or a style).'],
  quantization: ['Quantization', 'A compressed copy of a model that stores its numbers with fewer bits (8, 4 or even 2), so it needs less memory at a small cost in quality.'],
  adapter: ['Adapter (LoRA)', 'A small add-on file that modifies a base model without copying it. You need the base model to use it.'],
  merge: ['Merge', 'A model created by combining the weights of two or more existing models.'],
  family: ['Family', 'A group of related models, such as everything built on Qwen or Llama, detected from model names and declared base models.'],
  snapshot: ['Snapshot', 'A copy of the dataset at a point in time. The dataset publishes about three a day; this site compares them to measure change.'],
  context: ['Context window', 'How much text the model can look at at once (your conversation, documents, code), counted in tokens; 1,000 tokens ≈ 750 English words. A longer window needs more memory.'],
  kvcache: ['KV cache', 'Memory the model uses to remember the conversation so far. It grows with the context length and with each simultaneous user. Storing it in 8-bit halves it with almost no quality loss.'],
  speculative: ['Speculative decoding', 'A trick that makes generation faster: a tiny “draft” model (or extra heads built into the model, MTP) guesses several words ahead and the big model checks them all at once. Same answers, typically 1.5–2.5× faster for one user.'],
  moe: ['Mixture of experts (MoE)', 'A model split into many “experts” of which only a few work on each word. A 30B-A3B model must fit in memory as 30B but runs about as fast as a 3B one.'],
  thinking: ['Thinking', 'Some models reason step by step before answering. It improves hard answers but takes longer; hybrid models let you switch it off for quick replies.'],
  runtime: ['Runtime', 'The program that runs the model. Ollama and LM Studio are the easiest; llama.cpp gives full control; vLLM and SGLang are GPU servers for many users; MLX is Apple’s.'],
  quantlevel: ['Quantization level', 'How much the model is compressed. Q8 ≈ lossless, Q6/Q5 near-lossless, Q4 the usual sweet spot, Q3/Q2 noticeably worse. FP8, NVFP4, AWQ and MXFP4 are the formats GPU servers use.'],
  tps: ['Tokens per second', 'How fast the answer is written. A token is about ¾ of a word: 10 tokens/s is about reading speed, 30+ feels instant.'],
  ttft: ['Time to first token', 'How long the model takes to read your prompt before it starts answering. It grows with prompt length and depends on the GPU’s compute, not its memory speed.'],
  conversational: ['Chat / instruct', 'Models tuned to follow instructions and hold a conversation, as opposed to raw “base” models.'],
};

export function term(key, label) {
  const g = GLOSSARY[key];
  if (!g) return esc(label ?? key);
  return `<button type="button" class="term" data-term="${key}" aria-describedby="tooltip">${esc(label ?? g[0])}</button>`;
}

export function glossaryHtml(keys = Object.keys(GLOSSARY)) {
  return `<dl class="glossary">${keys.map((k) => `<div id="term-${k}"><dt>${esc(GLOSSARY[k][0])}</dt><dd>${esc(GLOSSARY[k][1])}</dd></div>`).join('')}</dl>`;
}

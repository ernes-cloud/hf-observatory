"""Model families (Qwen, Llama, Mistral...) detected from a model's repo name and base model.

The first matching pattern wins, and the declared base model is checked before
the model's own name, so a fine-tune named "my-assistant" whose base model is
``Qwen/Qwen3-8B`` counts as Qwen. Only the repo name is matched (the part after
"/"), never the author: an uploader called "llama-fan" does not make every upload Llama.
"""

# (family, regex, exclusion regex or None) over the lowercased repo name. Order matters.
# DuckDB's regex engine (RE2) has no look-around, so tools that merely contain a family's
# name (Ollama, llama.cpp, HuBERT...) are ruled out with the exclusion pattern.
FAMILIES: list[tuple[str, str, str | None]] = [
    ("Qwen", r"qwen|qwq", None),
    ("Llama", r"llama", r"ollama|llama[-_.]?cpp|llamafile|llama[-_]?index|llamaindex|llamafactory|llama[-_]factory"),
    ("Mistral", r"mistral|mixtral|ministral|magistral|devstral|codestral|voxtral|pixtral", None),
    ("Gemma", r"gemma", None),
    ("DeepSeek", r"deepseek", None),
    ("Phi", r"(^|[_\-. ])phi[-_ ]?\d", None),
    ("GLM", r"(^|[_\-. ])(chat)?glm", None),
    ("GPT-OSS", r"gpt-oss", None),
    ("Kimi", r"kimi|moonshot", None),
    ("MiniMax", r"minimax", None),
    ("Nemotron", r"nemotron", None),
    ("Granite", r"granite", None),
    ("SmolLM", r"smollm|smolvlm|smolvla", None),
    ("LFM", r"(^|[_\-. ])lfm", None),
    ("OLMo", r"(^|[^m])olmo", None),
    ("Falcon", r"falcon", None),
    ("Hunyuan", r"hunyuan", None),
    ("FLUX", r"flux", None),
    ("Stable Diffusion", r"stable-diffusion|stablediffusion|sdxl|sd3|sd-?1\.5", None),
    ("Z-Image", r"z-image|zimage", None),
    ("Krea", r"krea", None),
    ("Wan", r"(^|[_\-. ])wan[-_ ]?\d", None),
    ("LTX", r"ltx", None),
    ("Whisper", r"whisper", None),
    ("wav2vec2", r"wav2vec|w2v-?bert", None),
    ("Kokoro", r"kokoro", None),
    ("Chronos", r"chronos", None),
    ("CLIP / SigLIP", r"(^|[_\-. ])(open)?clip([_\-. ]|$)|siglip", None),
    ("ViT", r"(^|[_\-. ])(vit|deit|beit|dinov[23])([_\-. ]|$)", None),
    ("T5", r"(^|[_\-. ])(flan-|m|by|um)?t5([_\-. ]|$)", None),
    ("GPT-2", r"(^|[_\-. ])(distil)?gpt-?2([_\-. ]|$)", None),
    ("BERT-style", r"bert|electra|minilm|mpnet|(^|[_\-. ])(bge|e5)-", r"hubert"),
]


def family_case_sql(id_col: str = "id", base_col: str = "base_model") -> str:
    """A DuckDB CASE expression returning the family name (or NULL)."""
    parts = []
    for col in (base_col, id_col):
        # Repo name only; a base_model may list several parents, the first counts.
        text = f"lower(regexp_replace(split_part(coalesce({col}, ''), ',', 1), '^\\s*[^/]*/', ''))"
        for name, rx, exclude in FAMILIES:
            cond = f"regexp_matches({text}, '{rx.replace(chr(39), chr(39) * 2)}')"
            if exclude:
                cond += f" AND NOT regexp_matches({text}, '{exclude.replace(chr(39), chr(39) * 2)}')"
            parts.append(f"WHEN {cond} THEN '{name}'")
    return "CASE " + " ".join(parts) + " END"

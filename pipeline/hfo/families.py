"""Model families (Qwen, Llama, Mistral...) detected from a model's id and base model.

The first matching pattern wins, and the declared base model is checked before
the model's own id, so a fine-tune named "my-assistant" whose base model is
``Qwen/Qwen3-8B`` counts as Qwen.
"""

# (family, regex over the lowercased text). Order matters.
FAMILIES: list[tuple[str, str]] = [
    ("Qwen", r"qwen|qwq"),
    ("Llama", r"llama"),
    ("Mistral", r"mistral|mixtral|ministral|magistral|devstral|codestral|voxtral|pixtral"),
    ("Gemma", r"gemma|medgemma|paligemma"),
    ("DeepSeek", r"deepseek"),
    ("Phi", r"(^|[/_\-. ])phi[-_ ]?\d"),
    ("GLM", r"(^|[/_\-. ])(chat)?glm"),
    ("GPT-OSS", r"gpt-oss"),
    ("Kimi", r"kimi|moonshot"),
    ("MiniMax", r"minimax"),
    ("Nemotron", r"nemotron"),
    ("Granite", r"granite"),
    ("SmolLM", r"smollm|smolvlm|smolvla"),
    ("LFM", r"(^|[/_\-. ])lfm|liquidai"),
    ("OLMo", r"olmo"),
    ("Falcon", r"falcon"),
    ("FLUX", r"flux"),
    ("Stable Diffusion", r"stable-diffusion|stablediffusion|sdxl|sd3|sd-?1\.5"),
    ("Wan", r"(^|[/_\-. ])wan[-_ ]?\d"),
    ("LTX", r"ltx"),
    ("Whisper", r"whisper"),
    ("BERT-style", r"bert|electra|minilm|mpnet|(^|[/_\-. ])(bge|e5)-"),
]


def family_case_sql(id_col: str = "id", base_col: str = "base_model") -> str:
    """A DuckDB CASE expression returning the family name (or NULL)."""
    parts = []
    for col in (base_col, id_col):
        for name, rx in FAMILIES:
            rx_sql = rx.replace("'", "''")
            parts.append(f"WHEN regexp_matches(lower(coalesce({col}, '')), '{rx_sql}') THEN '{name}'")
    return "CASE " + " ".join(parts) + " END"

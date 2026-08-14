"""RAG 生成提示词加载器（复用 context/prompts.py 的惯例：md + {{name}} 占位符）。"""

from __future__ import annotations

from pathlib import Path

PROMPT_DIR = Path(__file__).resolve().parent / "prompts"

_cache: dict[str, str] = {}


def load_prompt(name: str) -> str:
    if name not in _cache:
        _cache[name] = (PROMPT_DIR / name).read_text(encoding="utf-8")
    return _cache[name]


def fill(template: str, **kwargs) -> str:
    for key, value in kwargs.items():
        template = template.replace("{{" + key + "}}", str(value))
    return template


def render(name: str, **kwargs) -> str:
    return fill(load_prompt(name), **kwargs)

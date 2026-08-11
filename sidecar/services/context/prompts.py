"""操作提示词加载器。

所有「缩减 / 拆卸 / 锚点提取」类操作提示词放在 prompts/ 目录，
模板占位符使用 {{name}}，由 fill() 做纯文本替换（避免 f-string 大括号冲突）。
"""

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

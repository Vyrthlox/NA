"""上下文缩减器：把超长 / 历史内容压成紧凑形式，供后续轮次的 LLM 上下文使用。

- 用户输入（长文本）→ 意图提取 + 关键片段保留
- 模型回复 → 结论 + 关键论据（丢弃推理链）
- 远期消息 → 事实锚点
- 工具调用：缩减结果（参数+结果摘要）是拆卸产物的子集，由拆卸步骤一并产出，
  此处仅提供上下文渲染帮助函数。
"""

from __future__ import annotations

import json
from typing import Any

from .llm import LLMClient
from .prompts import render
from .types import ToolReduced


def _as_message(prompt: str) -> list[dict[str, str]]:
    return [{"role": "system", "content": prompt}]


def _as_list(value: Any) -> list[str]:
    if isinstance(value, list):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str):
        return [value.strip()] if value.strip() else []
    return []


class Reducer:
    def __init__(self, llm: LLMClient) -> None:
        self.llm = llm

    def user_input(self, text: str) -> dict[str, Any]:
        """较长文本缩减 → {intent, key_fragments}。"""
        prompt = render("reduce_user.md", text=text[:4000])
        data = self.llm.chat_json(_as_message(prompt))
        return {"intent": data.get("intent"), "key_fragments": _as_list(data.get("key_fragments"))}

    def assistant_reply(self, text: str) -> dict[str, Any]:
        """模型回复缩减 → {conclusion, key_arguments}。"""
        prompt = render("reduce_assistant.md", text=text[:4000])
        data = self.llm.chat_json(_as_message(prompt))
        return {"conclusion": data.get("conclusion"), "key_arguments": _as_list(data.get("key_arguments"))}

    def extract_anchors(self, text: str) -> list[str]:
        """远期消息 → 事实锚点列表（用户偏好 / 已确认事实 / 长期约定）。"""
        prompt = render("extract_anchors.md", text=text[:4000])
        data = self.llm.chat_json(_as_message(prompt))
        anchors = data.get("anchors") if isinstance(data, dict) else None
        return _as_list(anchors)


def render_tool_for_context(t: ToolReduced) -> str:
    """工具调用的上下文展示：仅参数 + 结果摘要（缩减策略）。"""
    args = json.dumps(t.args, ensure_ascii=False) if t.args else "{}"
    return f"[工具调用] {t.name} 参数:{args} 结果:{t.result_summary or '无摘要'}"

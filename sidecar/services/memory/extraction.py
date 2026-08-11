"""长期记忆抽取：把一轮对话的拆卸内容结构化抽取为候选记忆。

复用 llm.py 的 LLMClient.chat_json（唯一 LLM 接入点），prompt 用
context/prompts/extract_memories.md（render() 加载）。LLM 不可用时返回空列表，
抽取不阻塞主流程（由 service.py 的 worker 异步调用）。
"""

from __future__ import annotations

from typing import Any

from ..context.llm import LLMClient
from ..context.prompts import render
from .types import CATEGORIES, MemoryDraft

# 类别中文标签（用于 format_blocks 展示）
CATEGORY_LABELS = {
    "preference": "偏好",
    "user_profile": "画像",
    "knowledge": "知识",
    "task_state": "任务",
}


def category_label(cat: str) -> str:
    return CATEGORY_LABELS.get(cat, cat)


class MemoryExtractor:
    """从拆卸内容中抽取候选长期记忆。"""

    def __init__(self, llm: LLMClient | None) -> None:
        self.llm = llm

    def available(self) -> bool:
        return self.llm is not None

    def extract_from_dismantled_turn(
        self,
        turn_payload: dict[str, Any],
        *,
        truncate_chars: int = 4000,
    ) -> list[MemoryDraft]:
        """输入 build_dismantled_payload 落盘的 turns[seq]，返回候选记忆列表。"""
        if not self.available():
            return []
        transcript = self.build_transcript(turn_payload)
        if not transcript.strip():
            return []
        prompt = render("extract_memories.md", text=transcript[:truncate_chars])
        try:
            data = self.llm.chat_json([{"role": "system", "content": prompt}], temperature=0.1)
        except Exception:
            return []  # LLM 不可用 / 解析失败：本轮不抽，交给 /memory/compact 重跑
        return self._parse_memories(data)

    def build_transcript(self, turn_payload: dict[str, Any]) -> str:
        """把 dismantled 的一轮结构化内容压成紧凑文本喂给抽取。"""
        parts: list[str] = []

        user = turn_payload.get("user") or {}
        user_text = user.get("text")
        if user_text:
            parts.append(f"用户说：{user_text}")
        if user.get("constraints"):
            parts.append(f"用户约束：{user.get('constraints')}")
        if user.get("intent"):
            parts.append(f"用户意图：{user.get('intent')}")

        assistant = turn_payload.get("assistant") or {}
        if assistant.get("conclusion"):
            parts.append(f"模型结论：{assistant.get('conclusion')}")
        if assistant.get("support"):
            parts.append(f"模型支撑：{assistant.get('support')}")

        for tc in turn_payload.get("tool_calls") or []:
            bits = [f"工具调用：{tc.get('name') or 'unknown'}"]
            if tc.get("call_intent"):
                bits.append(f"意图={tc.get('call_intent')}")
            if tc.get("result_summary"):
                bits.append(f"结果={tc.get('result_summary')}")
            if tc.get("args"):
                bits.append(f"参数={tc.get('args')}")
            parts.append("；".join(bits))

        return "\n".join(parts)

    def _parse_memories(self, data: Any) -> list[MemoryDraft]:
        if not isinstance(data, dict):
            return []
        items = data.get("memories")
        if not isinstance(items, list):
            return []
        drafts: list[MemoryDraft] = []
        for item in items:
            if not isinstance(item, dict):
                continue
            text = str(item.get("text") or "").strip()
            if not text:
                continue
            category = str(item.get("category") or "").strip().lower()
            if category not in CATEGORIES:
                category = "knowledge"  # 容错：未知类别归为知识
            try:
                importance = int(item.get("importance") or 3)
            except (TypeError, ValueError):
                importance = 3
            drafts.append(MemoryDraft(text=text, category=category, importance=max(1, min(5, importance))))
        return drafts

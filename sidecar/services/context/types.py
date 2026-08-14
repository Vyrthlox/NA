"""上下文引擎的数据结构。

一轮对话（Turn）= 用户输入 + 模型回复 +（可选）工具调用。

每个 Turn 持有两类信息：
- 保留形式（retained）：按分级策略用于 LLM 上下文 ——
  近期=原文，中期=意图摘要+关键结论，远期=事实锚点，工具=参数+结果摘要；
- 拆卸形式（dismantled）：始终保留并落盘到每对话的 dismantled.json ——
  用户{约束,意图}、回复{结论,支撑}、工具{调用意图,参数,结果摘要}。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


# ---------------- 拆卸形式（落盘 dismantled.json） ----------------

@dataclass
class UserDismantled:
    """用户输入拆卸：约束条件（保留）+ 用户意图（拆卸）。"""

    constraints: str | None = None
    intent: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"constraints": self.constraints, "intent": self.intent}


@dataclass
class AssistantDismantled:
    """模型回复拆卸：结论（保留）+ 支撑（拆卸）。"""

    conclusion: str | None = None
    support: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"conclusion": self.conclusion, "support": self.support}


@dataclass
class ToolCallDismantled:
    """工具调用拆卸（三层）：调用意图 / 调用参数 / 结果摘要。"""

    name: str
    args: dict[str, Any] = field(default_factory=dict)
    call_intent: str | None = None
    result_summary: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "args": self.args,
            "call_intent": self.call_intent,
            "result_summary": self.result_summary,
        }


# ---------------- 保留形式（用于上下文 / context.json） ----------------

@dataclass
class ToolReduced:
    """工具调用缩减结果：仅参数 + 返回结果摘要（其他丢弃）。"""

    name: str
    args: dict[str, Any] = field(default_factory=dict)
    result_summary: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "args": self.args, "result_summary": self.result_summary}

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "ToolReduced":
        return cls(
            name=data.get("name", ""),
            args=data.get("args") or {},
            result_summary=data.get("result_summary"),
        )


@dataclass
class Turn:
    """一轮对话及其分级保留状态。tier: recent | compressed | anchored

    kind: chat=普通对话 / kb=知识库问答。kb 轮次仅落盘历史展示，不参与上下文组装、
    不做分级压缩（assemble_messages / _recompute_tiers 跳过），保持「纯知识库问答」语义。
    """

    seq: int
    tier: str = "recent"
    kind: str = "chat"

    # --- 近期（全量原文） ---
    user_text: str | None = None
    assistant_text: str | None = None

    # --- 知识库问答引用来源（POST /knowledge/query 的 citations 元素，仅 kb 轮次携带） ---
    citations: list[dict[str, Any]] = field(default_factory=list)

    # --- 中期（压缩保留：用户意图摘要 + 关键结论，丢弃中间推理） ---
    user_intent_summary: str | None = None
    user_key_fragments: list[str] = field(default_factory=list)
    constraints: str | None = None  # 用户约束（拆卸中保留的部分）
    key_conclusions: list[str] = field(default_factory=list)

    # --- 远期（仅事实锚点） ---
    fact_anchors: list[str] = field(default_factory=list)

    # --- 工具调用保留形式（参数 + 结果摘要） ---
    tool_reduced: list[ToolReduced] = field(default_factory=list)

    # ---------------- 序列化 ----------------

    def to_dict(self) -> dict[str, Any]:
        return {
            "seq": self.seq,
            "tier": self.tier,
            "kind": self.kind,
            "user_text": self.user_text,
            "assistant_text": self.assistant_text,
            "citations": self.citations,
            "user_intent_summary": self.user_intent_summary,
            "user_key_fragments": self.user_key_fragments,
            "constraints": self.constraints,
            "key_conclusions": self.key_conclusions,
            "fact_anchors": self.fact_anchors,
            "tool_reduced": [t.to_dict() for t in self.tool_reduced],
        }

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Turn":
        t = cls(seq=int(data["seq"]), tier=data.get("tier", "recent"), kind=data.get("kind", "chat"))
        t.user_text = data.get("user_text")
        t.assistant_text = data.get("assistant_text")
        t.citations = list(data.get("citations") or [])
        t.user_intent_summary = data.get("user_intent_summary")
        t.user_key_fragments = list(data.get("user_key_fragments", []))
        t.constraints = data.get("constraints")
        t.key_conclusions = list(data.get("key_conclusions", []))
        t.fact_anchors = list(data.get("fact_anchors", []))
        t.tool_reduced = [ToolReduced.from_dict(x) for x in data.get("tool_reduced", [])]
        return t

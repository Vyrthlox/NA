"""上下文拆卸器：把用户输入 / 模型回复 / 工具调用拆成结构化部件。

拆卸产物始终保留，落盘到每对话的 dismantled.json。
- 用户输入 → {约束条件(保留), 用户意图(拆卸)}
- 模型回复 → {结论(保留), 支撑(拆卸)}
- 工具调用 → {调用意图(拆卸), 调用参数(保留), 结果摘要(保留)}
"""

from __future__ import annotations

import json
from typing import Any

from .llm import LLMClient
from .prompts import render
from .types import AssistantDismantled, ToolCallDismantled, UserDismantled


def _as_message(prompt: str) -> list[dict[str, str]]:
    """操作类提示词以单条 system 消息发送（输出格式已内嵌在提示词里）。"""
    return [{"role": "system", "content": prompt}]


class Dismantler:
    def __init__(self, llm: LLMClient) -> None:
        self.llm = llm

    def user_input(self, text: str) -> UserDismantled:
        """拆卸用户输入 → 约束条件 + 用户意图。"""
        prompt = render("dismantle_user.md", text=text)
        data = self.llm.chat_json(_as_message(prompt))
        return UserDismantled(
            constraints=_norm(data.get("constraints")),
            intent=_norm(data.get("intent")),
        )

    def assistant_reply(self, text: str) -> AssistantDismantled:
        """拆卸模型回复 → 结论 + 支撑。"""
        prompt = render("dismantle_assistant.md", text=text)
        data = self.llm.chat_json(_as_message(prompt))
        return AssistantDismantled(
            conclusion=_norm(data.get("conclusion")),
            support=_norm(data.get("support")),
        )

    def tool_call(self, name: str, args: dict[str, Any], result: str) -> ToolCallDismantled:
        """拆卸工具调用 → 调用意图 + 调用参数 + 结果摘要。"""
        prompt = render(
            "dismantle_tool.md",
            tool_name=name,
            args=json.dumps(args, ensure_ascii=False),
            result=result[:2000],
        )
        data = self.llm.chat_json(_as_message(prompt))
        return ToolCallDismantled(
            name=name,
            args=data.get("args") if isinstance(data.get("args"), dict) else args,
            call_intent=_norm(data.get("call_intent")),
            result_summary=_norm(data.get("result_summary")),
        )


def _norm(value: Any) -> str | None:
    """把 LLM 返回的字段规整为 str | None（去掉纯空串）。"""
    if value is None:
        return None
    s = str(value).strip()
    return s or None

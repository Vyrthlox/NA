"""逐对话 JSON 落盘。

每个对话一个目录 data/conversations/<conversation_id>/：
- context.json    ：分级保留的运行态（turns 各分级字段 + 元信息）。
- dismantled.json ：该对话所有「拆卸内容」（用户约束/意图、回复结论/支撑、工具调用三层），
                    按轮次 seq 组织 —— 即需求中「拆卸的内容用一个 json 文件分对话保存」。
"""

from __future__ import annotations

import json
import os
import shutil
from pathlib import Path
from typing import Any

from .types import AssistantDismantled, ToolCallDismantled, UserDismantled


def _atomic_write(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


class ConversationStorage:
    def __init__(self, conversations_dir: Path) -> None:
        self.root = Path(conversations_dir)

    # ---------------- 路径 ----------------

    def _dir(self, conversation_id: str) -> Path:
        # 防止路径穿越
        if "/" in conversation_id or "\\" in conversation_id or conversation_id in (".", ".."):
            raise ValueError(f"非法的 conversation_id：{conversation_id!r}")
        return self.root / conversation_id

    def context_path(self, conversation_id: str) -> Path:
        return self._dir(conversation_id) / "context.json"

    def dismantled_path(self, conversation_id: str) -> Path:
        return self._dir(conversation_id) / "dismantled.json"

    # ---------------- 读写 ----------------

    def save_context(self, conversation_id: str, context: dict[str, Any]) -> None:
        _atomic_write(self.context_path(conversation_id), context)

    def load_context(self, conversation_id: str) -> dict[str, Any] | None:
        path = self.context_path(conversation_id)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def save_dismantled(self, conversation_id: str, dismantled: dict[str, Any]) -> None:
        _atomic_write(self.dismantled_path(conversation_id), dismantled)

    def load_dismantled(self, conversation_id: str) -> dict[str, Any] | None:
        path = self.dismantled_path(conversation_id)
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))

    def delete_conversation(self, conversation_id: str) -> bool:
        """删除整个会话目录（context.json + dismantled.json + attachments/）。
        _dir() 自带路径穿越防护；目录不存在返回 False。"""
        conv_dir = self._dir(conversation_id)
        if not conv_dir.exists():
            return False
        shutil.rmtree(conv_dir)
        return True

    # ---------------- 便捷 ----------------

    def build_dismantled_payload(
        self,
        conversation_id: str,
        *,
        seq: int,
        user: UserDismantled | None = None,
        assistant: AssistantDismantled | None = None,
        tool_calls: list[ToolCallDismantled] | None = None,
    ) -> dict[str, Any]:
        """把一轮的拆卸产物写入 dismantled.json（按 seq 索引），返回完整内容。"""
        data = self.load_dismantled(conversation_id) or {"conversation_id": conversation_id, "turns": {}}
        data["turns"][str(seq)] = {
            "user": user.to_dict() if user else None,
            "assistant": assistant.to_dict() if assistant else None,
            "tool_calls": [tc.to_dict() for tc in (tool_calls or [])],
        }
        self.save_dismantled(conversation_id, data)
        return data

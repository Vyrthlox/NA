"""历史会话查询端点。

- GET /conversations            列出历史会话（按更新时间倒序），供前端右侧「历史对话」面板
- GET /conversations/<id>       返回单会话完整历史轮次，供前端恢复渲染消息流

数据源：data/conversations/<conversation_id>/context.json（ConversationStorage 的
context 文件，turns 为按 seq 有序的 list，每轮含 user_text/assistant_text）。
损坏 JSON / 缺 context.json 的目录跳过。
"""

from __future__ import annotations

import json
from typing import Any

from flask import Blueprint, current_app, jsonify

from sidecar.services.context.storage import ConversationStorage

bp = Blueprint("conversations", __name__)

# 标题取首条用户消息时的截断长度
_TITLE_MAX = 24
# 预览取最近一轮用户消息的截断长度
_PREVIEW_MAX = 32


def _storage() -> ConversationStorage:
    ctx_cfg = current_app.config["CTX_CFG"]
    return ConversationStorage(ctx_cfg.conversations_dir)


def _truncate(text: str | None, limit: int) -> str:
    if not text:
        return ""
    text = " ".join(text.split())  # 压缩空白/换行
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _load_context(storage: ConversationStorage, conversation_id: str) -> dict[str, Any] | None:
    """读 context.json，损坏/缺失返回 None（不打断整个列表）。"""
    try:
        return storage.load_context(conversation_id)
    except (json.JSONDecodeError, ValueError, OSError):
        return None


def _summarize(ctx: dict[str, Any], conversation_id: str) -> dict[str, Any]:
    """从 context.json 提炼列表项：标题=首条用户消息，preview=最近一轮用户消息。"""
    turns = ctx.get("turns") or []
    title = ""
    preview = ""
    for t in turns:
        user_text = (t.get("user_text") or "").strip()
        if user_text:
            if not title:
                title = user_text
            preview = user_text  # 遍历中不断刷新 → 结束时为最近一轮
    return {
        "conversation_id": conversation_id,
        "title": _truncate(title, _TITLE_MAX) or "未命名对话",
        "turn_count": len(turns),
        "updated_at": ctx.get("updated_at") or "",
        "preview": _truncate(preview, _PREVIEW_MAX),
    }


@bp.get("/conversations")
def conversations_list():
    storage = _storage()
    items: list[dict[str, Any]] = []
    if storage.root.exists():
        for child in storage.root.iterdir():
            if not child.is_dir():
                continue
            cid = child.name
            ctx = _load_context(storage, cid)
            if not ctx or not ctx.get("conversation_id"):
                continue
            items.append(_summarize(ctx, cid))
    items.sort(key=lambda x: x.get("updated_at") or "", reverse=True)
    return jsonify({"conversations": items})


@bp.get("/conversations/<conversation_id>")
def conversations_get(conversation_id: str):
    storage = _storage()
    ctx = _load_context(storage, conversation_id)
    if not ctx or not ctx.get("conversation_id"):
        return jsonify({"error": f"对话不存在：{conversation_id}"}), 404

    turns: list[dict[str, Any]] = []
    for t in ctx.get("turns") or []:
        seq = t.get("seq")
        user_text = (t.get("user_text") or "").strip()
        assistant_text = (t.get("assistant_text") or "").strip()
        if user_text:
            turns.append({"seq": seq, "role": "user", "text": user_text})
        if assistant_text:
            turns.append({"seq": seq, "role": "assistant", "text": assistant_text})

    return jsonify({"conversation_id": conversation_id, "turns": turns})


@bp.delete("/conversations/<conversation_id>")
def conversations_delete(conversation_id: str):
    storage = _storage()
    deleted = storage.delete_conversation(conversation_id)
    if not deleted:
        return jsonify({"error": f"对话不存在：{conversation_id}"}), 404
    # 若该会话仍缓存在内存注册表，一并移除，避免后续访问复活空会话
    current_app.config.get("CONVERSATIONS", {}).pop(conversation_id, None)
    return jsonify({"deleted": conversation_id})

"""对话注册表：conversation_id → ContextManager 的内存缓存。

- 首次访问且磁盘上已有该对话（data/conversations/<id>/）时，从 JSON 恢复续对话；
- 否则新建 ContextManager 并 create_conversation。
"""

from __future__ import annotations

from flask import Flask

from sidecar.services.context.context_manager import ContextManager
from sidecar.services.context.storage import ConversationStorage


def _memory_provider(app: Flask):
    """长期记忆注入回调：未启用时返回 None。"""
    svc = app.config.get("MEMORY_SERVICE")
    if svc and svc.enabled:
        return svc.provide_memory_blocks
    return None


def get_or_create_conversation(app: Flask, conversation_id: str | None) -> tuple[ContextManager, bool]:
    """返回 (ContextManager, 是否新建)。conversation_id 为空时自动生成。"""
    ctx_cfg = app.config["CTX_CFG"]
    registry: dict[str, ContextManager] = app.config["CONVERSATIONS"]
    provider = _memory_provider(app)

    if conversation_id and conversation_id in registry:
        return registry[conversation_id], False

    storage = ConversationStorage(ctx_cfg.conversations_dir)
    # 磁盘已存在该对话 → 续对话恢复
    if conversation_id and storage.load_context(conversation_id):
        cm = ContextManager(ctx_cfg, memory_provider=provider)
        cm.load_conversation(conversation_id)
        registry[conversation_id] = cm
        return cm, False

    cm = ContextManager(ctx_cfg, memory_provider=provider)
    cid = cm.create_conversation(conversation_id)
    registry[cid] = cm
    return cm, True

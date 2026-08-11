"""长期记忆管理端点。

- GET    /memory/list    ?limit=&category=&query=   列出记忆（query 存在时走语义检索）
- DELETE /memory/<id>                               删除一条记忆（不存在 404）
- POST   /memory/compact {"conversation_id"}        同步沉降整场对话（人工重跑抽取）
"""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify, request

bp = Blueprint("memory", __name__)


def _svc():
    return current_app.config.get("MEMORY_SERVICE")


@bp.get("/memory/list")
def memory_list():
    svc = _svc()
    if not svc:
        return jsonify({"memories": [], "error": "记忆服务未启用"}), 200
    try:
        limit = max(1, min(int(request.args.get("limit", 50)), 200))
    except (TypeError, ValueError):
        limit = 50
    category = request.args.get("category") or None
    query = (request.args.get("query") or "").strip() or None
    try:
        memories = svc.list_memories(limit=limit, category=category, query=query)
    except Exception as e:
        current_app.logger.exception("memory list failed")
        return jsonify({"error": str(e)}), 500
    return jsonify({"memories": memories})


@bp.delete("/memory/<memory_id>")
def memory_delete(memory_id: str):
    svc = _svc()
    if not svc:
        return jsonify({"error": "记忆服务未启用"}), 503
    try:
        ok = svc.delete_memory(memory_id)
    except Exception as e:
        current_app.logger.exception("memory delete failed")
        return jsonify({"error": str(e)}), 500
    if not ok:
        return jsonify({"error": f"记忆不存在：{memory_id}"}), 404
    return jsonify({"deleted": memory_id})


@bp.post("/memory/compact")
def memory_compact():
    svc = _svc()
    if not svc:
        return jsonify({"error": "记忆服务未启用"}), 503
    payload = request.get_json(silent=True) or {}
    conversation_id = (payload.get("conversation_id") or "").strip()
    if not conversation_id:
        return jsonify({"error": "conversation_id 不能为空"}), 400
    try:
        result = svc.compact_conversation(conversation_id)
    except Exception as e:
        current_app.logger.exception("memory compact failed")
        return jsonify({"error": str(e)}), 500
    return jsonify({"conversation_id": conversation_id, **result})

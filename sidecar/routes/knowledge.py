"""RAG 知识库端点（用户自建 KB 模型）。

KB 管理：
- GET    /knowledge/status                    索引状态 → {available, kbs:[...], embed_model, last_error}
- GET    /knowledge/kbs                       知识库列表 → {kbs:[{id,name,created_at,files,chunks,indexed}]}
- POST   /knowledge/kbs         {"name"}      创建知识库 → {id, name}（空名 400）
- DELETE /knowledge/kbs/<id>                  删除知识库（含索引目录）→ {ok}
- GET    /knowledge/kbs/<id>/files            文件列表 → {kb_id, files:[{rel,name,size,mtime}]}
- POST   /knowledge/kbs/<id>/files  multipart 上传文件（多 file part，filename=相对路径）→ {ok, stats}（变更+重建一体）
- DELETE /knowledge/kbs/<id>/files {"rel"}    删除文件 → {ok, stats}

检索/生成：
- POST /knowledge/reindex  {"incremental"?}    全量重建所有 KB（兼容/自测）→ {ok, stats}
- POST /knowledge/search   {"query","kb_id"?,"top_n"?}  检索 → {query, results:[...]}
- POST /knowledge/query    {"query","kb_id"?,"provider"?,"depth"?,"top_n"?,"conversation_id"?}
                                       检索+生成 → {query, answer, citations, conversation_id}（该轮问答落盘历史会话）

检索端点在 LLM 未配置时仍可用；生成端点缺 key 返回 503 并提示，不影响检索。
"""

from __future__ import annotations

from flask import Blueprint, current_app, jsonify, request

from sidecar.registry import get_or_create_conversation

bp = Blueprint("knowledge", __name__)


def _svc():
    return current_app.config.get("KNOWLEDGE_SERVICE")


def _clamp_int(payload: dict, name: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(payload.get(name, default))
    except (TypeError, ValueError):
        return default
    return max(lo, min(v, hi))


def _kb_id_from(payload: dict) -> str | None:
    kb_id = (payload.get("kb_id") or "").strip()
    return kb_id or None


def _kb_or_error(svc, kb_id: str):
    """校验 KB 存在；返回 (info, None) 或 (None, flask 响应)。"""
    info = svc.kb_info(kb_id)
    if info is None:
        return None, jsonify({"error": f"知识库不存在：{kb_id}"}), 404
    return info, None


# ---------------- 状态 / KB 管理 ----------------

@bp.get("/knowledge/status")
def knowledge_status():
    svc = _svc()
    if not svc:
        return jsonify({"available": False, "error": "知识库服务未启用"}), 503
    try:
        return jsonify(svc.status())
    except Exception as e:
        current_app.logger.exception("knowledge status failed")
        return jsonify({"error": str(e)}), 500


@bp.get("/knowledge/kbs")
def knowledge_kbs_list():
    svc = _svc()
    if not svc:
        return jsonify({"kbs": [], "error": "知识库服务未启用"}), 503
    try:
        return jsonify({"kbs": svc.list_kbs()})
    except Exception as e:
        current_app.logger.exception("knowledge kbs list failed")
        return jsonify({"error": str(e)}), 500


@bp.post("/knowledge/kbs")
def knowledge_kbs_create():
    svc = _svc()
    if not svc:
        return jsonify({"error": "知识库服务未启用"}), 503
    payload = request.get_json(silent=True) or {}
    name = (payload.get("name") or "").strip()
    if not name:
        return jsonify({"error": "知识库名称不能为空"}), 400
    try:
        rec = svc.create_kb(name)
    except Exception as e:
        current_app.logger.exception("knowledge kbs create failed")
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, "id": rec["id"], "name": rec["name"]})


@bp.delete("/knowledge/kbs/<kb_id>")
def knowledge_kbs_delete(kb_id: str):
    svc = _svc()
    if not svc:
        return jsonify({"error": "知识库服务未启用"}), 503
    try:
        ok = svc.delete_kb(kb_id)
    except Exception as e:
        current_app.logger.exception("knowledge kbs delete failed")
        return jsonify({"error": str(e)}), 500
    if not ok:
        return jsonify({"error": f"知识库不存在：{kb_id}", "ok": False}), 404
    return jsonify({"ok": True})


# ---------------- KB 文件 ----------------

@bp.get("/knowledge/kbs/<kb_id>/files")
def knowledge_kb_files(kb_id: str):
    svc = _svc()
    if not svc:
        return jsonify({"files": [], "error": "知识库服务未启用"}), 503
    info, err = _kb_or_error(svc, kb_id)
    if err is not None:
        return err
    try:
        return jsonify({"kb_id": kb_id, "files": svc.list_kb_files(kb_id)})
    except Exception as e:
        current_app.logger.exception("knowledge kb files failed")
        return jsonify({"error": str(e)}), 500


@bp.post("/knowledge/kbs/<kb_id>/files")
def knowledge_kb_upload(kb_id: str):
    svc = _svc()
    if not svc:
        return jsonify({"error": "知识库服务未启用"}), 503
    info, err = _kb_or_error(svc, kb_id)
    if err is not None:
        return err
    uploaded = request.files.getlist("file")
    if not uploaded:
        return jsonify({"error": "未收到文件（multipart 字段名应为 file）"}), 400
    try:
        files = [(f.filename or "", f.read()) for f in uploaded]
        stats = svc.upload_files(kb_id, files)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        current_app.logger.exception("knowledge kb upload failed")
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, "stats": stats})


@bp.delete("/knowledge/kbs/<kb_id>/files")
def knowledge_kb_delete_file(kb_id: str):
    svc = _svc()
    if not svc:
        return jsonify({"error": "知识库服务未启用"}), 503
    info, err = _kb_or_error(svc, kb_id)
    if err is not None:
        return err
    payload = request.get_json(silent=True) or {}
    rel = (payload.get("rel") or "").strip()
    if not rel:
        return jsonify({"error": "rel 不能为空"}), 400
    try:
        stats = svc.delete_kb_file(kb_id, rel)
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    except Exception as e:
        current_app.logger.exception("knowledge kb delete file failed")
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, "stats": stats})


# ---------------- 重建 / 检索 / 生成 ----------------

@bp.post("/knowledge/reindex")
def knowledge_reindex():
    svc = _svc()
    if not svc:
        return jsonify({"error": "知识库服务未启用"}), 503
    payload = request.get_json(silent=True) or {}
    incremental = bool(payload.get("incremental", True))
    try:
        stats = svc.reindex(incremental=incremental)
    except Exception as e:
        current_app.logger.exception("knowledge reindex failed")
        return jsonify({"error": str(e)}), 500
    return jsonify({"ok": True, **stats})


@bp.post("/knowledge/search")
def knowledge_search():
    svc = _svc()
    if not svc:
        return jsonify({"results": [], "error": "知识库服务未启用"}), 503
    payload = request.get_json(silent=True) or {}
    query = (payload.get("query") or "").strip()
    if not query:
        return jsonify({"error": "query 不能为空"}), 400
    kb_id = _kb_id_from(payload)
    if kb_id:
        info, err = _kb_or_error(svc, kb_id)
        if err is not None:
            return err
        if not info["indexed"]:
            return jsonify({"error": "该知识库为空，请先上传文件", "results": []}), 503
    elif not svc.indexed:
        return jsonify({"error": "知识库尚未索引，请先创建并上传文件", "results": []}), 503
    top_n = _clamp_int(payload, "top_n", svc.cfg.final_top, 1, svc.cfg.final_top_max)
    try:
        results = svc.search(query, kb_id=kb_id, top_n=top_n)
    except Exception as e:
        current_app.logger.exception("knowledge search failed")
        return jsonify({"error": str(e)}), 500
    return jsonify({"query": query, "results": [r.__dict__ for r in results]})


@bp.post("/knowledge/query")
def knowledge_query():
    svc = _svc()
    if not svc:
        return jsonify({"error": "知识库服务未启用"}), 503
    payload = request.get_json(silent=True) or {}
    query = (payload.get("query") or "").strip()
    if not query:
        return jsonify({"error": "query 不能为空"}), 400
    kb_id = _kb_id_from(payload)
    if kb_id:
        info, err = _kb_or_error(svc, kb_id)
        if err is not None:
            return err
        if not info["indexed"]:
            return jsonify({"error": "该知识库为空，请先上传文件", "results": []}), 503
    elif not svc.indexed:
        return jsonify({"error": "知识库尚未索引，请先创建并上传文件", "results": []}), 503
    provider = (payload.get("provider") or "").strip() or None
    depth = (payload.get("depth") or "").strip() or None
    top_n = _clamp_int(payload, "top_n", svc.cfg.final_top, 1, svc.cfg.final_top_max)
    conversation_id = (payload.get("conversation_id") or "").strip() or None
    try:
        out = svc.query(query, kb_id=kb_id, provider=provider, depth=depth, top_n=top_n)
    except KeyError as e:
        return jsonify({"error": f"LLM 未配置：{e}"}), 503
    except Exception as e:
        current_app.logger.exception("knowledge query failed")
        return jsonify({"error": str(e)}), 500
    # 落盘知识库问答轮次 → 历史会话可见（与 /chat 的 finalize_turn 对齐，但仅写 context.json、
    # 不做拆卸/分级）。落盘失败不影响回答返回，仅记录。
    try:
        cm, _is_new = get_or_create_conversation(current_app, conversation_id)
        cm.finalize_kb_turn(query, out.get("answer", ""), out.get("citations") or [])
        conversation_id = cm.conversation_id
    except Exception as e:
        current_app.logger.warning("knowledge query 落盘会话失败（不影响回答）：%s", e)
    return jsonify({"query": query, **out, "conversation_id": conversation_id})

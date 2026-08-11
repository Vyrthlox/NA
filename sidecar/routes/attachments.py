"""附件上传 / 删除路由（当前阶段：仅保存展示，不注入 AI 上下文）。

类型白名单 + 体积上限由 MAX_CONTENT_LENGTH（Flask 层）与扩展名校验双重把关。
文件落盘到 data/conversations/<conversation_id>/attachments/，元数据记录在
同目录 attachments.json（原子写），供后续知识库 / 检索阶段使用。
"""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from pathlib import Path

from flask import Blueprint, current_app, jsonify, request

bp = Blueprint("attachments", __name__)

# 附件元数据读-改-写互斥锁：一次选多个文件会并发上传，固定临时路径的原子写
# 存在竞态（写入交错 + os.replace 半截文件 → JSON 损坏），用锁串行化整个循环。
_META_LOCK = threading.Lock()

ALLOWED_EXT = {".pdf", ".docx", ".xlsx", ".txt", ".md", ".html", ".png", ".jpg", ".jpeg"}
# 兜底上限（与 app 的 MAX_CONTENT_LENGTH 一致；Flask 在解析 multipart 前就已拦截超限请求）
MAX_UPLOAD_BYTES = 100 * 1024 * 1024


def _attachments_dir(conversation_id: str) -> Path:
    """对话附件目录，含路径穿越防护。"""
    if "/" in conversation_id or "\\" in conversation_id or conversation_id in (".", ".."):
        raise ValueError(f"非法的 conversation_id：{conversation_id!r}")
    conversations_dir = Path(current_app.config["CTX_CFG"].conversations_dir)
    return conversations_dir / conversation_id / "attachments"


def _atomic_write_json(path: Path, data: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # 每次唯一临时名：即使未来出现未加锁的并发写，也不会互相截断同一文件
    tmp = path.with_name(f"{path.stem}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def _load_meta(attachments_dir: Path, conversation_id: str) -> dict:
    meta_path = attachments_dir / "attachments.json"
    if not meta_path.exists():
        return {"conversation_id": conversation_id, "attachments": []}
    return json.loads(meta_path.read_text(encoding="utf-8"))


@bp.post("/attachments")
def upload():
    f = request.files.get("file")
    if f is None or not f.filename:
        return jsonify({"error": "缺少 file 字段"}), 400

    conversation_id = (request.form.get("conversation_id") or "").strip() or "default"
    try:
        attachments_dir = _attachments_dir(conversation_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    name = Path(f.filename).name  # 仅取文件名，防路径穿越
    ext = Path(name).suffix.lower()
    if ext not in ALLOWED_EXT:
        return jsonify({"error": f"不支持的格式 {ext or '(无扩展名)'}，允许：{' '.join(sorted(ALLOWED_EXT))}"}), 400

    attachments_dir.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}{ext}"
    target = attachments_dir / stored_name
    f.save(target)  # FileStorage.save 流式写出，避免整文件常驻内存
    size = target.stat().st_size
    if size > MAX_UPLOAD_BYTES:  # 兜底（正常情况下 Flask 已拦截）
        target.unlink(missing_ok=True)
        return jsonify({"error": "文件超过 100MB 上限"}), 413

    # 读-改-写加锁，防止并发上传互相覆盖/交错写坏 attachments.json
    with _META_LOCK:
        meta = _load_meta(attachments_dir, conversation_id)
        entry = {
            "id": uuid.uuid4().hex,
            "name": name,
            "size": size,
            "mime": f.content_type or "application/octet-stream",
            "stored_name": stored_name,
            "uploaded_at": int(time.time()),
        }
        meta["attachments"].append(entry)
        _atomic_write_json(attachments_dir / "attachments.json", meta)
    return jsonify(entry)


@bp.delete("/attachments/<conversation_id>/<attachment_id>")
def delete(conversation_id: str, attachment_id: str):
    try:
        attachments_dir = _attachments_dir(conversation_id)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    with _META_LOCK:
        meta = _load_meta(attachments_dir, conversation_id)
        for i, a in enumerate(meta["attachments"]):
            if a["id"] == attachment_id:
                stored = attachments_dir / a["stored_name"]
                if stored.exists():
                    stored.unlink()
                meta["attachments"].pop(i)
                _atomic_write_json(attachments_dir / "attachments.json", meta)
                return jsonify({"ok": True})
    return jsonify({"error": "附件不存在"}), 404

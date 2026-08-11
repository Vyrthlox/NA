"""GET /healthz —— 存活 / 就绪检查（免鉴权，供主进程轮询）。"""

from __future__ import annotations

import time

from flask import Blueprint, current_app, jsonify

bp = Blueprint("health", __name__)


@bp.get("/healthz")
def healthz():
    return jsonify(
        {
            "status": "ok",
            "service": "na-sidecar",
            "model": current_app.config["CTX_CFG"].model,
            "conversations": len(current_app.config["CONVERSATIONS"]),
            "time": int(time.time()),
        }
    )

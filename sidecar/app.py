"""NA sidecar —— Flask 服务入口。

启动（仓库根目录）：
    python -m sidecar.app [--port N] [--host H]
    python -m sidecar.app --port 0     # 随机高位端口，写入 data/sidecar.status.json

架构：仅绑定 127.0.0.1；除 /healthz 外所有请求需 Authorization: Bearer <token>。
当前路由：GET /healthz、POST /chat（SSE 流式）、/memory/*（长期记忆，见 §7.9）。
后续按架构文档扩展：/tidy /beautify /notes/index /knowledge 等。
"""

from __future__ import annotations

import argparse
import os
import sys
import threading
import time
from pathlib import Path

# 兼容 `python sidecar/app.py` 直接运行（否则以 -m 运行也可）
REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from flask import Flask, jsonify, request  # noqa: E402

from sidecar.config import ServerConfig  # noqa: E402
from sidecar.routes.attachments import bp as attachments_bp  # noqa: E402
from sidecar.routes.chat import bp as chat_bp  # noqa: E402
from sidecar.routes.conversations import bp as conversations_bp  # noqa: E402
from sidecar.routes.health import bp as health_bp  # noqa: E402
from sidecar.routes.memory import bp as memory_bp  # noqa: E402
from sidecar.services.context.config import SidecarConfig  # noqa: E402
from sidecar.services.context.storage import ConversationStorage  # noqa: E402
from sidecar.services.memory.config import MemoryConfig  # noqa: E402
from sidecar.services.memory.service import MemoryService  # noqa: E402


def create_app(server_cfg: ServerConfig | None = None, context_cfg: SidecarConfig | None = None) -> Flask:
    server_cfg = server_cfg or ServerConfig()
    app = Flask(__name__)
    app.config["SERVER_CFG"] = server_cfg
    ctx_cfg = context_cfg or SidecarConfig()
    app.config["CTX_CFG"] = ctx_cfg
    app.config["CONVERSATIONS"] = {}  # conversation_id -> ContextManager（内存注册表）

    # 长期记忆服务（懒加载：仅 start() 后预热模型，未启用/缺依赖时 /chat 行为不变）
    app.config["MEMORY_SERVICE"] = MemoryService(
        ctx_cfg, MemoryConfig(), ConversationStorage(ctx_cfg.conversations_dir)
    )

    app.register_blueprint(health_bp)
    app.register_blueprint(chat_bp)
    app.register_blueprint(attachments_bp)
    app.register_blueprint(conversations_bp)
    app.register_blueprint(memory_bp)
    # 附件体积上限（MB→字节）：Flask 在解析 multipart 前即拦截超限请求（413）
    app.config["MAX_CONTENT_LENGTH"] = server_cfg.max_upload_mb * 1024 * 1024

    @app.before_request
    def check_auth():
        # /healthz 免鉴权，便于主进程存活轮询；其余一律校验 Bearer token
        if request.path == "/healthz":
            return None
        expected = f"Bearer {server_cfg.token}"
        if request.headers.get("Authorization", "") != expected:
            return jsonify({"error": "未授权"}), 401

    return app


def _pid_exists(pid: int) -> bool:
    """跨平台检查进程是否存活（无 psutil 依赖）。"""
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        # PROCESS_QUERY_LIMITED_INFORMATION = 0x1000；STILL_ACTIVE = 259
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = wintypes.DWORD()
            ok = ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(code))
            return bool(ok) and code.value == 259
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def start_parent_watchdog(ppid: int, interval: float = 2.0) -> None:
    """父进程存活看门狗：父进程一退出（含被硬杀），本进程立刻自我回收。

    Electron 主进程可能因 Ctrl+C / taskkill /F 等强制退出，JS 侧清理代码不执行；
    Windows 下 taskkill /T 也会因子进程在跑而拒绝优雅关闭父进程。
    这里由 sidecar 自查父进程存活，父死则自杀，杜绝孤儿进程。
    """

    def run() -> None:
        while True:
            if not _pid_exists(ppid):
                os._exit(0)
            time.sleep(interval)

    threading.Thread(target=run, name="parent-watchdog", daemon=True).start()


def run_server(app: Flask, server_cfg: ServerConfig) -> None:
    """绑定并常驻；把实际端口 + token 写入状态文件供主进程发现。"""
    from werkzeug.serving import make_server

    srv = make_server(server_cfg.host, server_cfg.port, app, threaded=True)
    actual_port = srv.server_port
    server_cfg.write_status(actual_port)
    print(f"NA sidecar 已启动: http://{server_cfg.host}:{actual_port}  (token: {server_cfg.token[:6]}…)", flush=True)
    # 后台预热记忆模型 + 启动异步沉降 worker
    memory_svc = app.config.get("MEMORY_SERVICE")
    if memory_svc:
        memory_svc.start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if memory_svc:
            memory_svc.shutdown()


def main() -> None:
    parser = argparse.ArgumentParser(description="NA sidecar 服务")
    parser.add_argument("--host", default=None, help="绑定地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, default=None, help="端口（默认读 SIDECAR_PORT，0=随机高位）")
    args = parser.parse_args()

    # 由 Electron 主进程注入时启用看门狗（直接手动运行不启用）
    ppid = os.environ.get("NA_SIDECAR_PARENT_PID")
    if ppid and ppid.isdigit():
        start_parent_watchdog(int(ppid))

    server_cfg = ServerConfig(host=args.host, port=args.port)
    app = create_app(server_cfg)
    run_server(app, server_cfg)


if __name__ == "__main__":
    main()

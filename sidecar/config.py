"""Sidecar 服务端配置：绑定地址 / 端口 / 鉴权 token。

遵循架构文档 §8：仅绑定 127.0.0.1，启动时生成随机 token，
写入 data/sidecar.status.json 供 Electron 主进程发现（端口 + token）。
token 也可用环境变量 SIDECAR_TOKEN 显式指定。
"""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

from dotenv import load_dotenv

# sidecar/config.py 向上 2 级 = 仓库根目录
REPO_ROOT = Path(__file__).resolve().parents[1]


class ServerConfig:
    def __init__(
        self,
        *,
        host: str | None = None,
        port: int | None = None,
        token: str | None = None,
        env_file: Path | str | None = None,
    ) -> None:
        env_path = Path(env_file) if env_file is not None else Path(
            os.environ.get("NA_ENV_FILE", REPO_ROOT / "temp" / ".env")
        )
        if env_path.exists():
            load_dotenv(env_path)

        self.host = host or os.environ.get("SIDECAR_HOST", "127.0.0.1")
        self.port = port if port is not None else int(os.environ.get("SIDECAR_PORT", "0"))
        self.token = token or os.environ.get("SIDECAR_TOKEN") or secrets.token_urlsafe(32)
        self.status_file = Path(os.environ.get("SIDECAR_STATUS_FILE", REPO_ROOT / "data" / "sidecar.status.json"))
        # 附件上传体积上限（MB），映射为 Flask MAX_CONTENT_LENGTH（字节）
        self.max_upload_mb = int(os.environ.get("MAX_UPLOAD_MB", "100"))

    def write_status(self, port: int) -> dict:
        """把实际绑定端口 + token 写入状态文件，供 Electron 主进程 / 测试读取。"""
        status = {
            "host": self.host,
            "port": port,
            "token": self.token,
            "pid": os.getpid(),
        }
        self.status_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.status_file.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(status, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, self.status_file)
        return status

    @classmethod
    def read_status(cls, path: Path | str | None = None) -> dict | None:
        p = Path(path) if path else Path(
            os.environ.get("SIDECAR_STATUS_FILE", REPO_ROOT / "data" / "sidecar.status.json")
        )
        if not p.exists():
            return None
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            return None

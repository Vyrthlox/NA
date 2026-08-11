"""Sidecar 上下文管理配置。

从环境变量 / .env 读取（不把任何 API KEY 写死在代码里）：
- 测试阶段默认读仓库根目录的 temp/.env（可用 NA_ENV_FILE 覆盖路径）。
- 后续接服务端大模型时，仅需替换 llm.py 的客户端，配置项不变。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from dotenv import load_dotenv

# sidecar/services/context/config.py 向上 4 级 = 仓库根目录
REPO_ROOT = Path(__file__).resolve().parents[3]


class SidecarConfig:
    """上下文管理引擎的全部配置。"""

    def __init__(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        model: str | None = None,
        n_recent: int | None = None,
        m_mid: int | None = None,
        long_text_chars: int | None = None,
        data_dir: Path | str | None = None,
        system_prompt_path: Path | str | None = None,
        env_file: Path | str | None = None,
    ) -> None:
        # 加载 .env（存在才加载；显式传入 env_file 时即使不存在也不报错）
        env_path = Path(env_file) if env_file is not None else Path(
            os.environ.get("NA_ENV_FILE", REPO_ROOT / "temp" / ".env")
        )
        if env_path.exists():
            load_dotenv(env_path)

        # --- LLM 配置（测试 key 来自 temp/.env，勿写死） ---
        self.api_key = api_key or os.environ.get("API_KEY", "")
        self.base_url = (base_url or os.environ.get("BASE_URL", "https://api.deepseek.com")).rstrip("/")
        self.model = model or os.environ.get("MODEL", "deepseek-v4-flash")
        self.timeout = float(os.environ.get("LLM_TIMEOUT", "120"))
        self.json_temperature = float(os.environ.get("LLM_JSON_TEMPERATURE", "0.2"))

        # --- 双 provider（模型选择）---
        # deepseek：文本 provider，变量无后缀；qwen：视觉 provider（图片能力），_IMG 后缀。
        # 各含 fast / deep 两档模型，由 LLMRouter 按 (provider, depth) 解析。
        self.providers: dict[str, dict[str, Any]] = {
            "deepseek": {
                "api_key": self.api_key,
                "base_url": self.base_url,
                "models": {
                    "fast": self.model,
                    "deep": os.environ.get("MODEL_DEEP", self.model),
                },
            },
            "qwen": {
                "api_key": os.environ.get("API_KEY_IMG", ""),
                "base_url": os.environ.get("BASE_URL_IMG", ""),
                "models": {
                    "fast": os.environ.get("MODEL_IMG", ""),
                    "deep": os.environ.get("MODEL_DEEP_IMG", ""),
                },
            },
        }
        self.default_provider = "deepseek"
        self.default_depth = "fast"

        # --- 分级保留阈值（轮），初始值 N=8 / M=16，后续按平均对话轮数动态调整 ---
        self.n_recent = n_recent if n_recent is not None else int(os.environ.get("CTX_N", "8"))
        self.m_mid = m_mid if m_mid is not None else int(os.environ.get("CTX_M", "16"))
        if not (0 < self.n_recent < self.m_mid):
            self.n_recent, self.m_mid = 8, 16

        # 用户输入长度超过该字符数视为「较长文本」，触发意图提取 + 关键片段保留
        self.long_text_chars = (
            long_text_chars if long_text_chars is not None else int(os.environ.get("CTX_LONG_CHARS", "800"))
        )

        # --- 数据与系统提示词路径 ---
        self.data_dir = Path(data_dir) if data_dir is not None else Path(
            os.environ.get("NA_DATA_DIR", REPO_ROOT / "data")
        )
        self.system_prompt_path = Path(system_prompt_path) if system_prompt_path is not None else Path(
            os.environ.get("SYSTEM_PROMPT_PATH", REPO_ROOT / "Prompt" / "SystemPrompt.md")
        )

    @property
    def conversations_dir(self) -> Path:
        """逐对话 JSON 落盘目录：data/conversations/<conversation_id>/"""
        return self.data_dir / "conversations"

    @property
    def stats_path(self) -> Path:
        """对话轮数统计（用于动态调整 N/M）：data/threshold_stats.json"""
        return self.data_dir / "threshold_stats.json"


def load_config(**overrides) -> SidecarConfig:
    return SidecarConfig(**overrides)

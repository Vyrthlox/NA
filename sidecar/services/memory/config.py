"""长期记忆配置（Mem0 + 本地向量）。

从环境变量 / .env 读取（与 SidecarConfig 同源，不写死任何 key）：
- 模型：本地 bge-small-zh-v1.5（embedding，512 维）+ bge-reranker-base（精排），离线无 key。
- 存储：qdrant 本地 on-disk 于 data/memory/，mem0 历史落 data/memory/history.db。
- 降级：MEMORY_ENABLED=0 或依赖缺失时，记忆功能整体空转，/chat 行为不受影响。
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

# sidecar/services/memory/config.py 向上 4 级 = 仓库根目录
REPO_ROOT = Path(__file__).resolve().parents[3]

# 融合权重默认值（合计≈1.0）：精排主导，业务信号为辅
_DEFAULT_WEIGHTS = (0.60, 0.15, 0.15, 0.05, 0.05)


def _env_bool(name: str, default: str) -> bool:
    return os.environ.get(name, default).strip().lower() in ("1", "true", "yes", "on")


class MemoryConfig:
    """长期记忆引擎的全部配置。"""

    def __init__(self, *, data_dir: Path | str | None = None, env_file: Path | str | None = None) -> None:
        # 与 SidecarConfig 一致：加载 .env（存在才加载；显式 env_file 不存在也不报错）
        env_path = Path(env_file) if env_file is not None else Path(
            os.environ.get("NA_ENV_FILE", REPO_ROOT / "temp" / ".env")
        )
        if env_path.exists():
            load_dotenv(env_path)

        # --- 开关与模型 ---
        self.enabled = _env_bool("MEMORY_ENABLED", "1")
        self.embed_model = os.environ.get("MEMORY_EMBED_MODEL", "BAAI/bge-small-zh-v1.5")
        self.rerank_model = os.environ.get("MEMORY_RERANK_MODEL", "BAAI/bge-reranker-base")
        self.embed_dims = int(os.environ.get("MEMORY_EMBED_DIMS", "512"))
        self.collection = os.environ.get("MEMORY_COLLECTION", "long_term_memory")

        # --- 检索 ---
        self.top_k = int(os.environ.get("MEMORY_TOP_K", "4"))            # 最终注入条数
        self.candidates = int(os.environ.get("MEMORY_CANDIDATES", "40"))  # 召回候选数
        self.min_score = float(os.environ.get("MEMORY_MIN_SCORE", "0.35"))
        self.merge_threshold = float(os.environ.get("MEMORY_MERGE_THRESHOLD", "0.85"))  # 语义去重合并阈值

        # --- 融合权重 ---
        self.w_rerank = float(os.environ.get("MEMORY_W_RERANK", "0.60"))
        self.w_recency = float(os.environ.get("MEMORY_W_RECENCY", "0.15"))
        self.w_importance = float(os.environ.get("MEMORY_W_IMPORTANCE", "0.15"))
        self.w_category = float(os.environ.get("MEMORY_W_CATEGORY", "0.05"))
        self.w_source = float(os.environ.get("MEMORY_W_SOURCE", "0.05"))
        self.half_life_days = float(os.environ.get("MEMORY_RECENCY_HALF_LIFE_DAYS", "30"))

        # --- 作用域与身份 ---
        self.scope = os.environ.get("MEMORY_SCOPE", "global")  # 未来按笔记本隔离时改为 notebook:<id>
        self.user_id = os.environ.get("MEMORY_USER_ID", "default")

        # --- 异步 worker ---
        self.worker_max_queue = int(os.environ.get("MEMORY_WORKER_MAX_QUEUE", "100"))
        self.shutdown_timeout = float(os.environ.get("MEMORY_SHUTDOWN_TIMEOUT", "5"))

        # --- 抽取 ---
        self.extract_truncate = int(os.environ.get("MEMORY_EXTRACT_TRUNCATE", "4000"))

        # --- 数据与模型缓存目录 ---
        base = Path(data_dir) if data_dir is not None else Path(
            os.environ.get("NA_DATA_DIR", REPO_ROOT / "data")
        )
        self.data_dir = base / "memory"
        self.models_cache_dir = Path(os.environ.get("MEMORY_MODEL_CACHE_DIR", self.data_dir / "models"))

        # mem0 遥测关闭 + HF 模型缓存落 data/memory/models（离线可预拷贝），须在 import mem0 前生效
        os.environ.setdefault("MEM0_TELEMETRY", "false")
        os.environ.setdefault("HF_HOME", str(self.models_cache_dir))
        # HF 模型下载端点：中国网络直连 huggingface.co 常不可达，默认走 hf-mirror.com（HF_ENDPOINT 可覆盖）
        os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

        self.validate_weights()

    @property
    def qdrant_path(self) -> Path:
        """qdrant 本地 on-disk 存储目录：data/memory/qdrant/"""
        return self.data_dir / "qdrant"

    @property
    def history_db_path(self) -> Path:
        """mem0 历史事件 SQLite：data/memory/history.db"""
        return self.data_dir / "history.db"

    @property
    def errors_journal(self) -> Path:
        """抽取失败记录（不自动重试，供 compact 重跑）：data/memory/errors.jsonl"""
        return self.data_dir / "errors.jsonl"

    def validate_weights(self) -> None:
        """融合权重必须非负且合计≈1，否则回退默认。"""
        weights = (self.w_rerank, self.w_recency, self.w_importance, self.w_category, self.w_source)
        if any(w < 0 for w in weights) or abs(sum(weights) - 1.0) > 1e-6:
            self.w_rerank, self.w_recency, self.w_importance, self.w_category, self.w_source = _DEFAULT_WEIGHTS

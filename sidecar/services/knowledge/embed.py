"""Embedding 封装：SentenceTransformer（bge-small-zh-v1.5）懒加载 + 批量编码。

- 惰性加载：首次调用才加载模型；失败 → available()=False，调用方降级，不抛异常。
- 输出已归一化（normalize_embeddings=True）：FAISS 用内积（IndexFlatIP）即余弦相似度。
- 线程安全：模型编码在内部锁内执行（加载/编码共用一把锁，避免并发 encode 竞态）。
"""

from __future__ import annotations

import threading
from typing import Any

import numpy as np

from .config import KnowledgeConfig

_BATCH = 32


class Embedder:
    def __init__(self, cfg: KnowledgeConfig) -> None:
        self.cfg = cfg
        self._lock = threading.Lock()
        self._model: Any = None
        self._available: bool | None = None  # None=尚未探测
        self._init_error: str | None = None

    # ---------------- 对外 ----------------

    def available(self) -> bool:
        if self._available is None:
            self._available = self._ensure_init()
        return self._available

    @property
    def last_error(self) -> str | None:
        return self._init_error

    @property
    def dims(self) -> int:
        return self.cfg.embed_dims

    def embed(self, texts: list[str]) -> np.ndarray:
        """批量编码并归一化，返回 float32 [n, dims]。空输入返回空数组。"""
        if not texts:
            return np.zeros((0, self.cfg.embed_dims), dtype=np.float32)
        if not self.available():
            raise RuntimeError(f"embedder 不可用：{self._init_error or '未知原因'}")
        with self._lock:
            vecs = self._model.encode(
                texts,
                batch_size=_BATCH,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
        return np.asarray(vecs, dtype=np.float32)

    def embed_query(self, query: str) -> np.ndarray:
        """单条 query 编码，返回 [1, dims] 归一化向量。"""
        return self.embed([query])

    # ---------------- 内部 ----------------

    def _ensure_init(self) -> bool:
        if self._model is not None:
            return True
        try:
            from sentence_transformers import SentenceTransformer  # 惰性导入
        except Exception as e:
            self._init_error = f"sentence-transformers 未安装：{e}"
            return False
        try:
            # CPU 桌面端：明确 device，避免意外 CUDA 依赖
            self._model = SentenceTransformer(self.cfg.embed_model, device="cpu")
            return True
        except Exception as e:
            self._init_error = f"embedding 模型加载失败：{e}"
            return False

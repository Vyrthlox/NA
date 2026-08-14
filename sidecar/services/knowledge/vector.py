"""FAISS 向量索引封装：按规模自选索引 + 落盘 + 查询；faiss 缺失时 numpy 暴力 IP 兜底。

索引分档（用户规格，向量已归一化 → IP 即余弦）：
- N < 100k        → IndexFlatIP（暴力检索，召回 100%）
- 100k ≤ N < 1M   → IVFFlat（nlist≈4√N，nprobe 可配，召回 ≥98%）
- N ≥ 1M          → IVFPQ（m=pq_m，召回 ≥95%）

向量数组始终保留在内存（供去重余弦/兜底检索），FAISS 只是加速器。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import numpy as np

from .config import KnowledgeConfig


class VectorIndex:
    def __init__(self, cfg: KnowledgeConfig) -> None:
        self.cfg = cfg
        self._vectors: np.ndarray | None = None  # [N, dims] float32 已归一化
        self._n = 0
        self._faiss: Any = None  # faiss 模块；None=不可用
        self._index: Any = None  # faiss 索引对象
        self._type = "numpy"     # flat / ivf_flat / ivf_pq / numpy
        self._probe()

    def _probe(self) -> None:
        if os.environ.get("KN_FAISS", "1").strip() in ("0", "false", "no"):
            return
        try:
            import faiss  # 惰性导入
            self._faiss = faiss
        except Exception:
            self._faiss = None

    @property
    def available(self) -> bool:
        return self._n > 0

    @property
    def index_type(self) -> str:
        return self._type

    @property
    def vectors(self) -> np.ndarray | None:
        return self._vectors

    # ---------------- 构建 ----------------

    def build(self, vectors: np.ndarray) -> str:
        """全量重建；返回实际索引类型名（flat/ivf_flat/ivf_pq/numpy）。"""
        arr = np.ascontiguousarray(np.asarray(vectors, dtype=np.float32))
        self._n = arr.shape[0] if arr.ndim == 2 else 0
        self._vectors = arr
        if self._n == 0:
            self._index = None
            self._type = "numpy"
            return self._type

        if self._faiss is None:
            self._index = None
            self._type = "numpy"
            return self._type

        dim = arr.shape[1]
        n = self._n
        flat_max = self.cfg.flat_threshold
        ivf_max = self.cfg.ivf_threshold
        try:
            if n < flat_max:
                idx = self._faiss.IndexFlatIP(dim)
                idx.add(arr)
                self._index = idx
                self._type = "flat"
            elif n < ivf_max:
                nlist = max(1, round(self.cfg.ivf_nlist_factor * (n ** 0.5)))
                quantizer = self._faiss.IndexFlatIP(dim)
                idx = self._faiss.IndexIVFFlat(quantizer, dim, nlist, self._faiss.METRIC_INNER_PRODUCT)
                self._train(idx, arr)
                idx.add(arr)
                idx.nprobe = min(self.cfg.ivf_nprobe, nlist)
                self._index = idx
                self._type = "ivf_flat"
            else:
                nlist = max(1, round(self.cfg.ivf_nlist_factor * (n ** 0.5)))
                quantizer = self._faiss.IndexFlatIP(dim)
                idx = self._faiss.IndexIVFPQ(
                    quantizer, dim, nlist, self.cfg.pq_m, 8, self._faiss.METRIC_INNER_PRODUCT
                )
                self._train(idx, arr)
                idx.add(arr)
                idx.nprobe = min(self.cfg.ivf_nprobe, nlist)
                self._index = idx
                self._type = "ivf_pq"
            return self._type
        except Exception:
            # FAISS 构建失败（罕见：训练崩溃等）→ 回退 numpy
            self._index = None
            self._type = "numpy"
            return self._type

    def _train(self, idx: Any, arr: np.ndarray) -> None:
        # 超大语料训练采样降耗（>50 万才采样）；本地量级直接全量
        if arr.shape[0] > 500_000:
            rng = np.random.default_rng(42)
            sample = arr[rng.choice(arr.shape[0], 200_000, replace=False)]
            idx.train(sample)
        else:
            idx.train(arr)

    # ---------------- 检索 ----------------

    def search(self, query_vec: np.ndarray, top_k: int) -> tuple[list[int], list[float]]:
        """返回 (positions, scores) 按分数降序；向量归一化时分数即余弦相似度。"""
        if self._n == 0:
            return [], []
        k = max(1, min(top_k, self._n))
        q = np.ascontiguousarray(np.asarray(query_vec, dtype=np.float32).reshape(1, -1))
        if self._index is not None and self._faiss is not None:
            try:
                scores, ids = self._index.search(q, k)
                return [int(i) for i in ids[0]], [float(s) for s in scores[0]]
            except Exception:
                pass  # 查询失败回退 numpy
        return self._numpy_search(q[0], k)

    def _numpy_search(self, q: np.ndarray, k: int) -> tuple[list[int], list[float]]:
        sims = self._vectors @ q  # [N]
        top = np.argpartition(-sims, k - 1)[:k]  # 前 k 个下标（无序）
        order = top[np.argsort(-sims[top])]
        return [int(i) for i in order], [float(sims[i]) for i in order]

    # ---------------- 落盘 ----------------

    def save(self, path: Path) -> None:
        """FAISS 索引 + 向量副本都落盘（numpy 兜底/去重复用向量）。"""
        path.parent.mkdir(parents=True, exist_ok=True)
        if self._index is not None and self._faiss is not None:
            try:
                self._faiss.write_index(self._index, str(path))
            except Exception:
                pass  # 写失败不阻断：npy 兜底足够重建
        if self._vectors is not None:
            np.save(str(path.with_suffix(".npy")), self._vectors)

    def load(self, path: Path) -> bool:
        """从磁盘恢复；成功返回 True。FAISS 缺失/损坏时仅加载向量（numpy 兜底）。"""
        npy = path.with_suffix(".npy")
        if npy.exists():
            try:
                arr = np.load(str(npy))
                self._vectors = np.ascontiguousarray(arr, dtype=np.float32)
                self._n = arr.shape[0] if arr.ndim == 2 else 0
            except Exception:
                return False
        if self._faiss is not None and path.exists():
            try:
                idx = self._faiss.read_index(str(path))
                if hasattr(idx, "nprobe"):
                    idx.nprobe = self.cfg.ivf_nprobe
                self._index = idx
                self._type = _infer_type(idx, self._faiss)
                return True
            except Exception:
                self._index = None
                self._type = "numpy"
        else:
            self._index = None
            self._type = "numpy"
        return self._n > 0


def _infer_type(idx: Any, faiss: Any) -> str:
    name = type(idx).__name__
    if "IVFPQ" in name:
        return "ivf_pq"
    if "IVF" in name:
        return "ivf_flat"
    return "flat"

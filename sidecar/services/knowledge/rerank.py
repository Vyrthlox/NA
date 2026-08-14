"""级联重排：轻量模型先选 topN，高精度模型再从候选里筛 final_top。

用户规格：先 ms-marco-MiniLM 从候选中选出前 10，再用 BGE-reranker-v2-m3 从 10 个中筛最终 3~5 个。
降级：轻量/高精度模型缺失或失败时逐级回退（高精度缺失 → 用轻量结果；轻量缺失 → 保持 RRF 顺序）。
"""

from __future__ import annotations

import threading
from typing import Any

from .config import KnowledgeConfig
from .tokenizer import truncate_to_tokens
from .types import Chunk


class CascadeReranker:
    def __init__(self, cfg: KnowledgeConfig) -> None:
        self.cfg = cfg
        self._lock = threading.Lock()
        self._light: Any = None
        self._heavy: Any = None
        self._light_ok: bool | None = None
        self._heavy_ok: bool | None = None
        self._light_error: str | None = None
        self._heavy_error: str | None = None

    # ---------------- 可用性 ----------------

    def light_available(self) -> bool:
        if self._light_ok is None:
            self._load(self._light_ok, "light")
        return bool(self._light_ok)

    def heavy_available(self) -> bool:
        if self._heavy_ok is None:
            self._load(self._heavy_ok, "heavy")
        return bool(self._heavy_ok)

    def _load(self, _flag: bool | None, which: str) -> None:
        with self._lock:
            if which == "light" and self._light_ok is not None:
                return
            if which == "heavy" and self._heavy_ok is not None:
                return
            try:
                from sentence_transformers import CrossEncoder  # 惰性导入
                if which == "light":
                    self._light = CrossEncoder(self.cfg.rerank_light_model, device="cpu")
                    self._light_ok = True
                else:
                    self._heavy = CrossEncoder(self.cfg.rerank_heavy_model, device="cpu")
                    self._heavy_ok = True
            except Exception as e:
                if which == "light":
                    self._light_ok = False
                    self._light_error = str(e)
                else:
                    self._heavy_ok = False
                    self._heavy_error = str(e)

    @property
    def light_error(self) -> str | None:
        return self._light_error

    @property
    def heavy_error(self) -> str | None:
        return self._heavy_error

    # ---------------- 级联 ----------------

    def rerank(self, query: str, chunks: list[Chunk], *, final_top: int) -> list[tuple[Chunk, float]]:
        """级联重排：返回 [(chunk, score)] 降序，长度 ≤ final_top。空输入返回 []。"""
        if not chunks:
            return []
        current = chunks
        scored: list[tuple[Chunk, float]] = []

        # 第一级：轻量模型选 light_top
        if self.light_available():
            scored = self._score(query, current, self._light) or [(c, 0.0) for c in current]
            scored.sort(key=lambda cs: cs[1], reverse=True)
            current = [c for c, _s in scored[: self.cfg.rerank_light_top]]
        else:
            current = current[: self.cfg.rerank_light_top]

        # 第二级：高精度模型筛 final_top（默认关闭——CPU 上逐查询加载/打分不可行，首查会卡 ~12.5s；--heavy 显式开启）
        if self.cfg.rerank_heavy_enabled and self.heavy_available():
            scored = self._score(query, current, self._heavy)
            if scored:
                scored.sort(key=lambda cs: cs[1], reverse=True)
                return scored[:final_top]
            # 高精度失败 → 回退第一级结果
            return [(c, 0.0) for c in current[:final_top]]
        # 高精度缺失 → 第一级结果（无重排则保持原顺序）
        return [(c, s) for c, s in scored[:final_top]] if scored else [(c, 0.0) for c in current[:final_top]]

    def _score(self, query: str, chunks: list[Chunk], model: Any) -> list[tuple[Chunk, float]]:
        try:
            cap = self.cfg.rerank_max_tokens
            # 打分只送文本前缀（cap≤0 不截），控制 CrossEncoder 成本；Chunk 本身保持全文
            if cap > 0:
                pairs = [(query, truncate_to_tokens(c.text, cap)) for c in chunks]
            else:
                pairs = [(query, c.text) for c in chunks]
            scores = model.predict(pairs, batch_size=16, show_progress_bar=False)
            return list(zip(chunks, [float(s) for s in scores]))
        except Exception:
            return []

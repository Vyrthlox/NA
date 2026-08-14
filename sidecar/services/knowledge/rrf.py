"""RRF 排名融合 + 去重。

用户规格：
- chunk_id 精确去重：以 chunk_id 为唯一键，同一个 chunk 只保留一次，保留 RRF 融合分最高者；
- 相似度去重：chunk_id 去重后，两个结果 embedding 余弦 > 0.92 视为相似，保留分数高者。
RRF 分数 = Σ 1/(k + rank)，rank 从 1 计，k 默认 60。
"""

from __future__ import annotations

from typing import Iterable

import numpy as np

from .config import KnowledgeConfig


def rrf_fuse(result_sets: Iterable[list[tuple[str, float]]], k: int) -> list[tuple[str, float]]:
    """多路结果（各为 [(chunk_id, score)]，按 rank 有序）融合为 [(chunk_id, rrf)] 降序。"""
    agg: dict[str, float] = {}
    for ranked in result_sets:
        for rank, (chunk_id, _score) in enumerate(ranked, start=1):
            agg[chunk_id] = agg.get(chunk_id, 0.0) + 1.0 / (k + rank)
    return sorted(agg.items(), key=lambda kv: kv[1], reverse=True)


def dedup_chunk_id(fused: list[tuple[str, float]]) -> list[tuple[str, float]]:
    """chunk_id 精确去重：同一 chunk 只保留一次（RRF 分最高者）。

    输入通常已按分降序，取首个即最高；保留防御性 max 语义。
    """
    seen: dict[str, float] = {}
    for chunk_id, score in fused:
        seen[chunk_id] = max(seen.get(chunk_id, 0.0), score)
    return sorted(seen.items(), key=lambda kv: kv[1], reverse=True)


def dedup_cosine(
    fused: list[tuple[str, float]],
    position_of: dict[str, int],
    vectors: np.ndarray | None,
    threshold: float,
) -> list[tuple[str, float]]:
    """相似度去重：按 RRF 降序逐个保留，与已保留结果余弦 > 阈值则丢弃（保留分数更高者）。

    输入为 chunk_id 去重后的 [(chunk_id, rrf)]；position_of 提供 chunk_id → 向量数组下标。
    vectors 缺失（无 embedding）时跳过相似度去重。
    """
    if vectors is None or len(vectors) == 0:
        return list(fused)
    kept: list[tuple[str, float]] = []
    kept_vecs: list[np.ndarray] = []
    for chunk_id, score in fused:
        pos = position_of.get(chunk_id, -1)
        if pos < 0 or pos >= len(vectors):
            kept.append((chunk_id, score))
            continue
        v = vectors[pos]
        if any(float(kv @ v) > threshold for kv in kept_vecs):
            continue  # 与已保留者相似 → 丢弃（保分数高者）
        kept.append((chunk_id, score))
        kept_vecs.append(v)
    return kept


def dedupe(
    result_sets: Iterable[list[tuple[str, float]]],
    cfg: KnowledgeConfig,
    position_of: dict[str, int],
    vectors: np.ndarray | None,
) -> list[tuple[str, float]]:
    """完整去重链路：RRF 融合 → chunk_id 精确去重 → 余弦相似度去重。"""
    fused = rrf_fuse(result_sets, cfg.rrf_k)
    return dedup_cosine(dedup_chunk_id(fused), position_of, vectors, cfg.cosine_dup_threshold)

"""长期记忆检索：混合召回 → 精排归一 → 业务信号融合 → top-k。

mem0 的 search 已做语义 + BM25 + 实体提升的混合召回并带 cross-encoder 精排，
这里在其之上做业务定制：
- rerank_score（无界 logit，可负）min-max 归一；
- 融合打分 final = w_rerank·rerank_norm + w_recency·recency_decay + w_importance·importance_norm
                    + w_category·category_boost + w_source·source_conf；
- 阈值过滤 → 近义去重 → 取 top_k。
"""

from __future__ import annotations

import difflib
from datetime import datetime, timezone
from typing import Any

from .config import MemoryConfig
from .extraction import category_label
from .store import MemoryStore
from .types import MemoryHit

# 类别触发词：查询命中时给对应类别记忆加权（偏好/画像/任务类有明确信号，knowledge 走纯语义）
CATEGORY_TRIGGERS: dict[str, tuple[str, ...]] = {
    "preference": ("偏好", "喜欢", "希望", "习惯", "风格", "格式", "简洁", "不要", "别", "用中文"),
    "user_profile": ("我是", "我叫", "我的", "职业", "工作", "住在", "身份", "背景"),
    "task_state": ("进行", "在做", "项目", "任务", "进度", "待办", "下一步", "决定", "方案"),
}

# 来源可信度：不同类别的记忆被确认的强度（knowledge 是已确认事实，任务状态最弱）
SOURCE_CONF: dict[str, float] = {
    "knowledge": 1.0,
    "user_profile": 0.8,
    "preference": 0.6,
    "task_state": 0.3,
}


class MemoryRetriever:
    def __init__(self, store: MemoryStore, cfg: MemoryConfig) -> None:
        self.store = store
        self.cfg = cfg

    def retrieve(self, query: str, *, top_k: int | None = None, scope: str | None = None) -> list[MemoryHit]:
        """检索 + 融合排序，返回按 final_score 降序的记忆。"""
        if not self.store.available():
            return []
        raws = self.store.search(query, top_k=self.cfg.candidates, scope=scope or self.cfg.scope)
        if not raws:
            return []
        hits = [self._to_hit(r) for r in raws if r.get("memory")]
        if not hits:
            return []
        self._normalize_rerank(hits)
        for h in hits:
            h.final_score = self._fusion_score(h, query)
        hits = [h for h in hits if h.final_score >= self.cfg.min_score]
        hits.sort(key=lambda h: h.final_score, reverse=True)
        hits = self._dedupe(hits)
        return hits[: top_k or self.cfg.top_k]

    def format_blocks(self, hits: list[MemoryHit]) -> list[str]:
        """格式化为注入 prompt 的行：`[偏好·重要3] 文本（来源 conv-xxx · 2026-08-11）`"""
        blocks: list[str] = []
        for h in hits:
            src = h.source_conversation_id or "未知会话"
            date = self._date_str(h.created_at)
            blocks.append(
                f"[{category_label(h.category)}·重要{h.importance}] {h.text}"
                f"（来源 {src}{(' · ' + date) if date else ''}）"
            )
        return blocks

    # ---------------- 分量 ----------------

    def _to_hit(self, r: dict[str, Any]) -> MemoryHit:
        meta = r.get("metadata") or {}
        try:
            seq = int(meta.get("source_seq") or 0)
        except (TypeError, ValueError):
            seq = 0
        try:
            importance = int(meta.get("importance") or 3)
        except (TypeError, ValueError):
            importance = 3
        rerank = r.get("rerank_score")
        return MemoryHit(
            memory_id=r.get("id") or "",
            text=r.get("memory") or "",
            category=meta.get("category") or "knowledge",
            importance=importance,
            scope=meta.get("scope") or self.cfg.scope,
            source_conversation_id=meta.get("source_conversation_id") or "",
            source_seq=seq,
            created_at=r.get("created_at") or "",
            score=float(r.get("score") or 0),
            rerank_score=float(rerank) if rerank is not None else None,
        )

    def _normalize_rerank(self, hits: list[MemoryHit]) -> None:
        """min-max 归一化 rerank logit 到 [0,1]；无精排分 → 0.5 中性。"""
        scores = [h.rerank_score for h in hits if h.rerank_score is not None]
        if not scores:
            for h in hits:
                h.rerank_score = 0.5
            return
        lo, hi = min(scores), max(scores)
        if hi - lo < 1e-9:
            for h in hits:
                h.rerank_score = 0.5 if h.rerank_score is None else 0.5
            return
        for h in hits:
            if h.rerank_score is None:
                h.rerank_score = 0.5
            else:
                h.rerank_score = (h.rerank_score - lo) / (hi - lo)

    def _fusion_score(self, h: MemoryHit, query: str) -> float:
        return (
            self.cfg.w_rerank * float(h.rerank_score or 0.5)
            + self.cfg.w_recency * self._recency_decay(h.created_at)
            + self.cfg.w_importance * self._importance_norm(h.importance)
            + self.cfg.w_category * self._category_boost(h.category, query)
            + self.cfg.w_source * self._source_conf(h.category)
        )

    def _recency_decay(self, created_at: str) -> float:
        """指数时间衰减，半衰期 half_life_days 天。"""
        if not created_at:
            return 0.5
        try:
            dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except ValueError:
            return 0.5
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        age_days = max(0.0, (datetime.now(timezone.utc) - dt).total_seconds() / 86400.0)
        return 0.5 ** (age_days / self.cfg.half_life_days)

    def _importance_norm(self, importance: int) -> float:
        """1→0，5→1。"""
        return (max(1, min(5, importance)) - 1) / 4.0

    def _category_boost(self, category: str, query: str) -> float:
        """查询命中类别触发词 → 1，否则 0。"""
        triggers = CATEGORY_TRIGGERS.get(category, ())
        return 1.0 if any(t in query for t in triggers) else 0.0

    def _source_conf(self, category: str) -> float:
        return SOURCE_CONF.get(category, 0.5)

    def _dedupe(self, hits: list[MemoryHit]) -> list[MemoryHit]:
        """近义去重：与已保留的记忆文本相似度≥0.8 则丢弃（保留分数更高者）。"""
        kept: list[MemoryHit] = []
        for h in hits:
            if all(difflib.SequenceMatcher(None, h.text, k.text).ratio() < 0.8 for k in kept):
                kept.append(h)
        return kept

    @staticmethod
    def _date_str(created_at: str) -> str:
        if not created_at:
            return ""
        try:
            dt = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            return dt.strftime("%Y-%m-%d")
        except ValueError:
            return ""

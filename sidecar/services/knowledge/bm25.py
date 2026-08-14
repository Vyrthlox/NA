"""手写 BM25（per-doc 参数）。

为什么手写而非 rank_bm25：用户规格要求每个 chunk 按 token 长度切换「短文档/长文档」参数，
rank_bm25 只支持全语料统一 k1/b，无法表达。手写支持：
- auto 模式：chunk token 数 < 阈值 → 短 {k1:1.2, b:0.5}，否则长 {k1:1.5, b:0.8}；
- exact 模式：全部 doc 用 k1=0（命中项各计 IDF，强调出现而非词频）——精确匹配配置 {0.0, 0.75}。
idf 用 BM25Okapi 同款平滑：log(1 + (N-df+0.5)/(df+0.5))。
"""

from __future__ import annotations

import math
from collections import Counter

from .config import KnowledgeConfig
from .types import Chunk


class BM25Index:
    def __init__(self, cfg: KnowledgeConfig) -> None:
        self.cfg = cfg
        self._postings: dict[str, list[int]] = {}   # term -> [doc_idx]
        self._counters: list[Counter] = []          # 每 doc 的词频
        self._doc_len: list[int] = []
        self._k1b: list[tuple[float, float]] = []   # 每 doc (k1, b)
        self._idf: dict[str, float] = {}
        self._chunk_ids: list[str] = []
        self._n = 0
        self._avgdl = 0.0
        self._built = False

    # ---------------- 索引 ----------------

    def build(self, chunks: list[Chunk]) -> None:
        """全量重建。chunk_id 与位置一一对应（与 chunks 数组、FAISS 整数 id 对齐）。"""
        self.reset()
        docs_tokens: list[list[str]] = []
        for ch in chunks:
            tokens = _tokenize_text(ch.text)
            docs_tokens.append(tokens)
        self._n = len(docs_tokens)
        if self._n == 0:
            self._built = True
            return
        self._avgdl = sum(len(t) for t in docs_tokens) / self._n

        df: Counter = Counter()
        for tokens in docs_tokens:
            for t in set(tokens):
                df[t] += 1
        for t, f in df.items():
            self._idf[t] = math.log(1.0 + (self._n - f + 0.5) / (f + 0.5))

        for idx, tokens in enumerate(docs_tokens):
            counter = Counter(tokens)
            self._counters.append(counter)
            self._doc_len.append(len(tokens))
            self._chunk_ids.append(chunks[idx].chunk_id)
            # 短/长文档参数按 chunk token 数切换
            if len(tokens) < self.cfg.short_doc_threshold:
                k1b = (self.cfg.bm25_short["k1"], self.cfg.bm25_short["b"])
            else:
                k1b = (self.cfg.bm25_long["k1"], self.cfg.bm25_long["b"])
            self._k1b.append(k1b)
            for t in counter:
                self._postings.setdefault(t, []).append(idx)

        self._built = True

    def reset(self) -> None:
        self._postings.clear()
        self._counters.clear()
        self._doc_len.clear()
        self._k1b.clear()
        self._idf.clear()
        self._chunk_ids.clear()
        self._n = 0
        self._avgdl = 0.0
        self._built = False

    @property
    def built(self) -> bool:
        return self._built

    @property
    def size(self) -> int:
        return self._n

    # ---------------- 检索 ----------------

    def search(self, query_tokens: list[str], *, top_k: int, exact: bool = False) -> list[tuple[str, float]]:
        """按 query token 检索，返回 [(chunk_id, score)] 降序。

        exact=True 时所有 doc 用 k1=0（精确匹配配置）。无命中返回 []。
        """
        if not self._built or self._n == 0 or not query_tokens:
            return []
        terms = list(dict.fromkeys(query_tokens))  # 去重：每个 term 只计一次
        scores: dict[int, float] = {}
        for t in terms:
            idf = self._idf.get(t, 0.0)
            if idf <= 0:
                continue
            for idx in self._postings.get(t, ()):
                tf = self._counters[idx][t]
                if exact:
                    k1, b = 0.0, self.cfg.bm25_exact["b"]
                else:
                    k1, b = self._k1b[idx]
                dl = self._doc_len[idx]
                denom = tf + k1 * (1.0 - b + b * dl / self._avgdl) if self._avgdl else 0.0
                contrib = idf * (tf * (k1 + 1.0)) / denom if denom > 0 else idf
                scores[idx] = scores.get(idx, 0.0) + contrib
        if not scores:
            return []
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[: max(1, top_k)]
        return [(self._chunk_ids[idx], score) for idx, score in ranked]


# 延迟导入 tokenize，避免循环依赖（tokenizer 无 knowledge 依赖，仅习惯性放在函数内）
from .tokenizer import tokenize as _tokenize  # noqa: E402


def _tokenize_text(text: str) -> list[str]:
    return _tokenize(text)

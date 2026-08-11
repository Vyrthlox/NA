"""Mem0 封装：惰性初始化、线程安全、去重合并、安全降级。

关键点（按 mem0 2.0.x 源码核对）：
- 包名 mem0ai，import 才是 mem0；`Memory.from_config(dict)` 顶层键 vector_store/llm/embedder/
  reranker/history_db_path/version。
- llm 块是构造期硬性要求但 `add(infer=False)` 下**永不调用** —— 这里配 provider=deepseek，
  全部取自 SidecarConfig 同一份 env；未来换服务端大模型只需改 `_build_llm_config()` 一处。
- `add(messages, infer=False)` 原样存储、零 LLM；user_id 必须放 filters（顶层传会 ValueError）。
- qdrant 本地需 path + on_disk=True + embedding_model_dims（bge-small-zh=512）+ collection_name。
- 任何依赖/模型加载失败 → `_available=False`，所有调用安全返回空，sidecar 正常可用。
"""

from __future__ import annotations

import difflib
import threading
from typing import Any

from ..context.config import SidecarConfig
from .config import MemoryConfig


class MemoryStore:
    """长期记忆的 Mem0 存储/检索封装。"""

    def __init__(self, cfg: MemoryConfig, ctx_cfg: SidecarConfig) -> None:
        self.cfg = cfg
        self.ctx_cfg = ctx_cfg
        self._lock = threading.RLock()
        self._mem: Any = None
        self._available: bool | None = None  # None=尚未探测
        self._init_error: str | None = None

    # ---------------- 对外操作 ----------------

    def available(self) -> bool:
        """是否可用（首次调用触发探测：import mem0 + 加载模型，可能较慢）。"""
        if self._available is None:
            self._available = self._ensure_init()
        return self._available

    @property
    def last_error(self) -> str | None:
        """最近一次初始化/操作失败原因（诊断用）。"""
        return self._init_error

    def add(
        self,
        text: str,
        *,
        category: str,
        importance: int,
        source_conversation_id: str,
        source_seq: int,
        scope: str | None = None,
    ) -> dict[str, Any] | None:
        """写入一条记忆：先查语义重复，高分且文本相似则 update 合并，否则 add(infer=False)。
        返回 {"id","event":"ADD"|"UPDATE"} 或 None（不可用/失败）。"""
        if not self.available() or not text.strip():
            return None
        metadata: dict[str, Any] = {
            "category": category,
            "importance": max(1, min(5, int(importance))),
            "scope": scope or self.cfg.scope,
            "source_conversation_id": source_conversation_id,
            "source_seq": int(source_seq),
        }
        with self._lock:
            dup = self._find_duplicate(text)
            if dup:
                try:
                    merged = dict(metadata)
                    merged["importance"] = max(
                        int(metadata["importance"]),
                        int((dup.get("metadata") or {}).get("importance", 3)),
                    )
                    self._mem.update(dup["id"], text=text, metadata=merged)
                    return {"id": dup["id"], "event": "UPDATE"}
                except Exception:
                    pass  # 合并失败回退为新增
            try:
                res = self._mem.add(
                    text,
                    user_id=self.cfg.user_id,
                    metadata=metadata,
                    infer=False,  # 原样存储，绕过 mem0 内部 LLM 抽取
                )
            except Exception as e:
                self._init_error = f"mem0 add 失败：{e}"
                return None
            results = res.get("results") or []
            if not results:
                return None
            return {"id": results[0].get("id"), "event": results[0].get("event", "ADD")}

    def search(self, query: str, *, top_k: int | None = None, scope: str | None = None) -> list[dict[str, Any]]:
        """混合检索（语义 + BM25 + 实体提升），rerank 由 mem0 内置 reranker 执行。
        返回 mem0 原始结果列表；threshold=0.0 不预筛，交由上层融合过滤。

        ⚠️ 过滤键用顶层：mem0 把自定义 metadata 平铺进 qdrant payload（scope 在顶层），
        用 `metadata.scope` 过滤会 0 命中；读取结果时 mem0 才重新嵌套回 metadata 字段。"""
        if not self.available():
            return []
        filters: dict[str, Any] = {"user_id": self.cfg.user_id}
        if scope:
            filters["scope"] = scope
        with self._lock:
            try:
                res = self._mem.search(
                    query,
                    top_k=top_k or self.cfg.candidates,
                    filters=filters,
                    threshold=0.0,
                    rerank=True,
                )
            except Exception as e:
                self._init_error = f"mem0 search 失败：{e}"
                return []
        return res.get("results") or []

    def list_all(self, *, limit: int = 50, category: str | None = None) -> list[dict[str, Any]]:
        """按 user_id 列出全部记忆（可选按 category 过滤）。"""
        if not self.available():
            return []
        with self._lock:
            try:
                res = self._mem.get_all(filters={"user_id": self.cfg.user_id}, top_k=limit)
            except Exception as e:
                self._init_error = f"mem0 get_all 失败：{e}"
                return []
        results = res.get("results") or []
        if category:
            results = [r for r in results if (r.get("metadata") or {}).get("category") == category]
        return results

    def get(self, memory_id: str) -> dict[str, Any] | None:
        """按 id 取单条记忆（mem0 无公开 get 接口，遍历 list 匹配）。"""
        for r in self.list_all(limit=1000):
            if r.get("id") == memory_id:
                return r
        return None

    def delete(self, memory_id: str) -> bool:
        """删除一条记忆；不存在返回 False。"""
        if not self.available():
            return False
        with self._lock:
            try:
                self._mem.delete(memory_id)
                return True
            except Exception:
                return False

    # ---------------- 内部 ----------------

    def _ensure_init(self) -> bool:
        if self._mem is not None:
            return True
        try:
            from mem0 import Memory  # 惰性导入：失败时记忆整体降级，sidecar 不受影响
        except Exception as e:
            self._init_error = f"mem0 未安装：{e}"
            return False
        try:
            self._mem = Memory.from_config(self._build_mem0_config())
            return True
        except Exception as e:
            self._init_error = f"mem0 初始化失败：{e}"
            return False

    def _build_mem0_config(self) -> dict[str, Any]:
        return {
            "llm": self._build_llm_config(),
            "embedder": {
                "provider": "huggingface",  # sentence_transformers.SentenceTransformer
                "config": {"model": self.cfg.embed_model, "model_kwargs": {"device": "cpu"}},
            },
            "vector_store": {
                "provider": "qdrant",
                "config": {
                    "collection_name": self.cfg.collection,
                    "path": str(self.cfg.qdrant_path),
                    "on_disk": True,
                    "embedding_model_dims": self.cfg.embed_dims,  # bge-small-zh=512，默认 1536 会维度不匹配
                },
            },
            "reranker": {
                "provider": "sentence_transformer",  # CrossEncoder bge-reranker
                "config": {"model": self.cfg.rerank_model, "device": "cpu", "batch_size": 32},
            },
            "history_db_path": str(self.cfg.history_db_path),
            "version": "v1.1",
        }

    def _build_llm_config(self) -> dict[str, Any]:
        """mem0 构造期占位的 llm 块（infer=False 下从不被调用）。
        未来接服务端大模型：把这里改为通用 OpenAI 兼容（provider=openai + openai_base_url）即可。"""
        if not self.ctx_cfg.api_key:
            # 离线无 key：用空配置占位（不会被调用），仅让 mem0 构造通过
            return {"provider": "openai", "config": {}}
        return {
            "provider": "deepseek",
            "config": {
                "model": self.ctx_cfg.model,
                "api_key": self.ctx_cfg.api_key,
                "deepseek_base_url": self.ctx_cfg.base_url,
                "temperature": 0.1,
            },
        }

    def _find_duplicate(self, text: str) -> dict[str, Any] | None:
        """语义去重：query=text 检索 top1，rerank 分≥merge_threshold 且文本相似≥0.5 视为同一记忆。

        ⚠️ 不用 mem0 的 score 字段：其数值是内部归一后的分数（相同文本也只有 ~0.52），
        不可作为绝对阈值；rerank_score（cross-encoder 输出，相同文本 ~1.0）才是有效相似度信号。
        """
        if not self.available():
            return None
        try:
            hits = self.search(text, top_k=3, scope=self.cfg.scope)
        except Exception:
            return None
        if not hits:
            return None
        # 在候选里挑文本最相似的（SequenceMatcher 处理前缀/措辞微差）
        best = hits[0]
        best_ratio = 0.0
        for h in hits:
            candidate = h.get("memory") or h.get("data") or ""
            ratio = difflib.SequenceMatcher(None, text, candidate).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best = h
        rerank = float(best.get("rerank_score") or 0)
        if rerank < self.cfg.merge_threshold:
            return None
        if best_ratio < 0.5:
            return None
        return best

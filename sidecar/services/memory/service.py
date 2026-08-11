"""长期记忆服务：后台异步沉降 + 检索注入 + 只读降级。

- 抽取时机：每轮 /chat done 后 enqueue_extraction(cid, seq)，单 worker 异步执行，不阻塞流式。
- 注入：provide_memory_blocks 作为 memory_provider 回调注入 ContextManager 锚点块之后；
  任何异常都吞掉返回 None，绝不阻断对话。
- 降级：MEMORY_ENABLED=0 / 依赖缺失 / 无 API_KEY（只读）时整体空转，/chat 行为不变。
- 错误落 data/memory/errors.jsonl，不自动重试；/memory/compact 人工重跑整个对话。
"""

from __future__ import annotations

import json
import logging
import queue
import threading
from typing import Any

from ..context.config import SidecarConfig
from ..context.llm import DeepSeekClient, LLMClient, LLMError
from ..context.storage import ConversationStorage
from .config import MemoryConfig
from .extraction import MemoryExtractor
from .retrieval import MemoryRetriever
from .store import MemoryStore

logger = logging.getLogger(__name__)

# 队列哨兵：None 表示关闭
_STOP = None


class MemoryService:
    def __init__(
        self,
        ctx_cfg: SidecarConfig,
        mem_cfg: MemoryConfig,
        storage: ConversationStorage,
        llm: LLMClient | None = None,
        store: MemoryStore | None = None,
    ) -> None:
        self.ctx_cfg = ctx_cfg
        self.cfg = mem_cfg
        self.storage = storage

        # LLM：注入的优先，否则按 llm.py 构造（无 key → None，只读模式，抽取停用）
        if llm is None:
            try:
                llm = DeepSeekClient(ctx_cfg)
            except LLMError:
                llm = None
        self.llm = llm

        # store 可注入复用（自测/多实例场景避免 qdrant “already accessed”：同一 path 只允许一个 client）
        self.store = store if store is not None else MemoryStore(mem_cfg, ctx_cfg)
        self.extractor = MemoryExtractor(llm)
        self.retriever = MemoryRetriever(self.store, mem_cfg)

        self._queue: queue.Queue = queue.Queue(maxsize=self.cfg.worker_max_queue)
        self._worker: threading.Thread | None = None
        self._started = False
        self._ready = False  # 后台预热完成后置 True；此前记忆功能不参与（不阻塞 /chat）

    # ---------------- 生命周期 ----------------

    @property
    def enabled(self) -> bool:
        """配置开启且预热完成（模型可用）。预热未完成视为未启用，保证关键路径零阻塞。"""
        return bool(self.cfg.enabled and self._ready)

    @property
    def available(self) -> bool:
        """只读可用（即使 LLM 缺失，检索仍可用）。"""
        return bool(self.cfg.enabled and self._ready)

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        self._ensure_worker()
        threading.Thread(target=self._warmup, name="memory-warmup", daemon=True).start()
        logger.info("memory service start requested (enabled=%s)", self.cfg.enabled)

    def shutdown(self) -> None:
        if not self._started:
            return
        self._started = False
        try:
            self._queue.put_nowait(_STOP)
        except queue.Full:
            pass
        if self._worker is not None:
            try:
                self._worker.join(timeout=self.cfg.shutdown_timeout)
            except Exception:
                pass
        logger.info("memory service stopped")

    def _warmup(self) -> None:
        try:
            self._ready = self.store.available()
        except Exception:
            self._ready = False
        if self._ready:
            logger.info("memory ready: qdrant=%s", self.cfg.qdrant_path)
        else:
            logger.warning("memory unavailable: %s", self.store.last_error or "未知原因")

    def _ensure_worker(self) -> None:
        if self._worker is None or not self._worker.is_alive():
            self._worker = threading.Thread(target=self._worker_loop, name="memory-worker", daemon=True)
            self._worker.start()

    # ---------------- 检索注入（ContextManager memory_provider 回调） ----------------

    def provide_memory_blocks(self, user_text: str) -> list[str] | None:
        """对用户本轮输入检索长期记忆并格式化为注入行；任何异常返回 None（绝不阻断对话）。"""
        if not self.enabled or not user_text or not user_text.strip():
            return None
        try:
            hits = self.retriever.retrieve(user_text)
        except Exception:
            logger.exception("memory retrieve failed")
            return None
        if not hits:
            return None
        return self.retriever.format_blocks(hits)

    # ---------------- 异步沉降 ----------------

    def enqueue_extraction(self, conversation_id: str, seq: int) -> None:
        """每轮 done 后入队（不阻塞）。预读确认该轮拆卸已落盘；队列满则丢弃。"""
        if not self.enabled:
            return
        try:
            data = self.storage.load_dismantled(conversation_id)
        except Exception:
            return
        turn = (data or {}).get("turns", {}).get(str(seq))
        if not turn:
            return
        try:
            self._queue.put_nowait((conversation_id, seq))
        except queue.Full:
            logger.warning("memory queue full, drop cid=%s seq=%s", conversation_id, seq)

    def compact_conversation(self, conversation_id: str) -> dict[str, Any]:
        """同步沉降整个对话（人工触发 /memory/compact），返回 {stored, skipped, errors}。"""
        result = {"stored": 0, "skipped": 0, "errors": 0}
        if not self.available:
            return result
        try:
            data = self.storage.load_dismantled(conversation_id)
        except Exception as e:
            self._append_error_journal(conversation_id, None, e)
            result["errors"] += 1
            return result
        turns = (data or {}).get("turns", {})
        for seq_str, turn in turns.items():
            try:
                drafts = self.extractor.extract_from_dismantled_turn(turn, truncate_chars=self.cfg.extract_truncate)
                if not drafts:
                    result["skipped"] += 1
                    continue
                for d in drafts:
                    if self.store.add(
                        d.text,
                        category=d.category,
                        importance=d.importance,
                        source_conversation_id=conversation_id,
                        source_seq=int(seq_str),
                        scope=self.cfg.scope,
                    ):
                        result["stored"] += 1
            except Exception as e:
                result["errors"] += 1
                self._append_error_journal(conversation_id, int(seq_str), e)
        return result

    # ---------------- 管理接口 ----------------

    def list_memories(self, *, limit: int = 50, category: str | None = None, query: str | None = None) -> list[dict[str, Any]]:
        if not self.available:
            return []
        if query and query.strip():
            try:
                hits = self.retriever.retrieve(query, top_k=limit)
            except Exception:
                return []
            return [self._serialize_hit(h) for h in hits]
        raws = self.store.list_all(limit=limit, category=category)
        return [self._serialize_raw(r) for r in raws]

    def delete_memory(self, memory_id: str) -> bool:
        if not self.available:
            return False
        return self.store.delete(memory_id)

    # ---------------- 内部 ----------------

    def _worker_loop(self) -> None:
        while True:
            item = self._queue.get()
            if item is _STOP:
                break
            conversation_id, seq = item
            try:
                self._process_item(conversation_id, seq)
            except Exception as e:
                self._append_error_journal(conversation_id, seq, e)

    def _process_item(self, conversation_id: str, seq: int) -> None:
        data = self.storage.load_dismantled(conversation_id)
        turn = (data or {}).get("turns", {}).get(str(seq))
        if not turn:
            return
        drafts = self.extractor.extract_from_dismantled_turn(turn, truncate_chars=self.cfg.extract_truncate)
        for d in drafts:
            self.store.add(
                d.text,
                category=d.category,
                importance=d.importance,
                source_conversation_id=conversation_id,
                source_seq=seq,
                scope=self.cfg.scope,
            )

    def _append_error_journal(self, conversation_id: str, seq: int | None, error: Exception) -> None:
        try:
            self.cfg.errors_journal.parent.mkdir(parents=True, exist_ok=True)
            with self.cfg.errors_journal.open("a", encoding="utf-8") as f:
                f.write(
                    json.dumps(
                        {
                            "conversation_id": conversation_id,
                            "seq": seq,
                            "error": str(error),
                        },
                        ensure_ascii=False,
                    )
                    + "\n"
                )
        except Exception:
            logger.exception("failed to write memory errors journal")

    def _serialize_hit(self, h: Any) -> dict[str, Any]:
        return {
            "id": h.memory_id,
            "text": h.text,
            "category": h.category,
            "importance": h.importance,
            "scope": h.scope,
            "source_conversation_id": h.source_conversation_id,
            "source_seq": h.source_seq,
            "created_at": h.created_at,
            "score": round(h.final_score, 4),
            "rerank_score": round(h.rerank_score, 4) if h.rerank_score is not None else None,
        }

    def _serialize_raw(self, r: dict[str, Any]) -> dict[str, Any]:
        meta = r.get("metadata") or {}
        rerank = r.get("rerank_score")
        return {
            "id": r.get("id"),
            "text": r.get("memory"),
            "category": meta.get("category"),
            "importance": meta.get("importance"),
            "scope": meta.get("scope"),
            "source_conversation_id": meta.get("source_conversation_id"),
            "source_seq": meta.get("source_seq"),
            "created_at": r.get("created_at"),
            "score": r.get("score"),
            "rerank_score": float(rerank) if rerank is not None else None,
        }

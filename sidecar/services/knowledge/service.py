"""RAG 知识库服务：用户自建知识库（KB）+ 每 KB 独立索引 → 混合召回 → RRF 融合 → 级联重排 → LLM 生成。

与旧模型（自动索引 data/library/ 的单一全局索引）不同：知识库由用户自建，每个 KB 有独立索引目录
data/knowledge/<id>/（files/ 存上传文件 + chunks.jsonl + faiss.index），**变更即重建**——
建/传/删文件同步完成「写文件 + reindex」后返回，前端用「正在更改」加载条掩盖。

生命周期/降级镜像 MemoryService：
- start() 后台温载（加载 KB 注册表 + 预载轻量重排模型），不阻塞 /chat；
- 任何依赖缺失（jieba/faiss/embedding/重排模型/LLM key）逐级降级，sidecar 整体不挂；
- reindex 持锁，search 读快照引用，避免与重建竞态。
"""

from __future__ import annotations

import logging
import os
import shutil
import threading
import time
from pathlib import Path
from typing import Any

import numpy as np

from ..context.config import SidecarConfig
from ..context.llm import LLMRouter
from .bm25 import BM25Index
from .chunker import chunk_document
from .config import KnowledgeConfig
from .embed import Embedder
from .prompts import render as render_prompt
from .extract import extract_document
from .registry import KbRegistry
from .rerank import CascadeReranker
from .rrf import dedupe
from .store import ALLOWED_EXTS, KnowledgeStore
from .tokenizer import extract_quoted, looks_like_identifier, tokenize
from .types import SearchResult
from .vector import VectorIndex

logger = logging.getLogger(__name__)


def safe_rel_path(name: str) -> str:
    """上传文件相对路径校验：拒绝绝对路径 / `..` 段（防路径穿越），返回 posix 相对路径。"""
    name = (name or "").replace("\\", "/")
    if name.startswith("/") or name.startswith("//"):
        raise ValueError("不允许绝对路径")
    parts = [p for p in name.split("/") if p]
    if not parts:
        raise ValueError("文件名不能为空")
    if any(p in (".", "..") for p in parts):
        raise ValueError(f"路径不允许包含 . 或 ..：{name}")
    return "/".join(parts)


class _KbIndex:
    """单个知识库的内存索引态：store + BM25 + FAISS。Embedder/Reranker 由服务共享（模型只加载一份）。"""

    def __init__(self, cfg: KnowledgeConfig) -> None:
        self.cfg = cfg
        self.store = KnowledgeStore(cfg)
        self.bm25 = BM25Index(cfg)
        self.vector = VectorIndex(cfg)
        self.loaded = False  # store.load_index() 已跑过
        self.indexed = False  # 有可检索 chunk


class KnowledgeService:
    def __init__(
        self,
        ctx_cfg: SidecarConfig,
        kn_cfg: KnowledgeConfig,
        llm_router: LLMRouter | None = None,
        *,
        embedder: Embedder | None = None,
        reranker: CascadeReranker | None = None,
        registry: KbRegistry | None = None,
    ) -> None:
        self.ctx_cfg = ctx_cfg
        self.cfg = kn_cfg
        self.cfg.validate()
        self.router = llm_router if llm_router is not None else LLMRouter(ctx_cfg)

        self.embedder = embedder if embedder is not None else Embedder(kn_cfg)
        self.reranker = reranker if reranker is not None else CascadeReranker(kn_cfg)
        self.registry = registry if registry is not None else KbRegistry(kn_cfg.data_dir / "kbs.json")

        self._lock = threading.RLock()
        self._started = False
        self._ready = False  # 温载完成（无论成败），此后端点可响应
        self._kb: dict[str, _KbIndex] = {}  # 懒加载缓存的 KB 索引
        self.last_error: str | None = None
        self.last_stats: dict[str, Any] = {}

    # ---------------- 生命周期 ----------------

    @property
    def enabled(self) -> bool:
        return bool(self.cfg.enabled and self._ready)

    @property
    def available(self) -> bool:
        return bool(self.cfg.enabled and self._ready)

    @property
    def indexed(self) -> bool:
        """任一 KB 已建索引（兼容旧状态语义）。"""
        if not (self.cfg.enabled and self._ready):
            return False
        return any(k["indexed"] for k in self.list_kbs())

    def start(self) -> None:
        if self._started:
            return
        self._started = True
        threading.Thread(target=self._warmup, name="knowledge-warmup", daemon=True).start()
        logger.info("knowledge service start requested (enabled=%s)", self.cfg.enabled)

    def shutdown(self) -> None:
        self._started = False

    def _warmup(self) -> None:
        try:
            # 只加载注册表 + 预载轻量重排模型；不再启动时全量扫库（索引按需 / 变更即建）
            self.registry.list()
            self.reranker.light_available()
            self.last_error = None
        except Exception as e:
            self.last_error = str(e)
            logger.warning("knowledge warmup failed: %s", e)
        finally:
            self._ready = True

    # ---------------- 知识库（KB）管理 ----------------

    def _kb_cfg(self, kb_id: str) -> KnowledgeConfig:
        return KnowledgeConfig(data_dir=self.cfg.data_dir.parent, kb_id=kb_id)

    def _ensure_kb(self, kb_id: str) -> _KbIndex:
        kb = self._kb.get(kb_id)
        if kb is None:
            kb = _KbIndex(self._kb_cfg(kb_id))
            self._kb[kb_id] = kb
        return kb

    def _load_kb(self, kb_id: str) -> _KbIndex:
        """确保 KB 内存索引就绪：优先 load 磁盘既有索引。持锁幂等。"""
        kb = self._ensure_kb(kb_id)
        if kb.loaded:
            return kb
        with self._lock:
            if kb.loaded:
                return kb
            if kb.store.load_index() and kb.store.chunks:
                self._rebuild_from_store(kb)
                kb.indexed = True
            kb.loaded = True
        return kb

    def _rebuild_from_store(self, kb: _KbIndex) -> None:
        chunks = kb.store.chunks
        kb.bm25.build(chunks)
        vecs = kb.store.vectors
        if vecs is not None and len(vecs) > 0:
            if not kb.vector.load(kb.cfg.faiss_path):
                kb.vector.build(vecs)

    def _count_files(self, kb: _KbIndex) -> int:
        root = kb.cfg.files_dir
        if not root.exists():
            return 0
        return sum(1 for _ in root.rglob("*") if _.is_file())

    def _count_chunks(self, kb: _KbIndex) -> int:
        p = kb.cfg.chunks_path
        if not p.exists():
            return 0
        try:
            with open(p, encoding="utf-8") as f:
                return sum(1 for line in f if line.strip())
        except Exception:
            return 0

    def kb_info(self, kb_id: str) -> dict[str, Any] | None:
        """单个 KB 摘要（注册表元数据 + 文件数 + chunk 数 + 是否已索引）；不存在返回 None。"""
        rec = next((r for r in self.registry.list() if r.get("id") == kb_id), None)
        if rec is None:
            return None
        kb = self._ensure_kb(kb_id)
        chunks = self._count_chunks(kb)
        return {**rec, "files": self._count_files(kb), "chunks": chunks, "indexed": chunks > 0}

    def list_kbs(self) -> list[dict[str, Any]]:
        return [self.kb_info(r["id"]) for r in self.registry.list()]

    def create_kb(self, name: str) -> dict[str, Any]:
        rec = self.registry.create(name)
        self._ensure_kb(rec["id"]).cfg.files_dir.mkdir(parents=True, exist_ok=True)
        return rec

    def delete_kb(self, kb_id: str) -> bool:
        self._kb.pop(kb_id, None)
        ok = self.registry.delete(kb_id)
        if ok:
            shutil.rmtree(self.cfg.data_dir / kb_id, ignore_errors=True)
        return ok

    def list_kb_files(self, kb_id: str) -> list[dict[str, Any]]:
        kb = self._ensure_kb(kb_id)
        root = kb.cfg.files_dir
        result: list[dict[str, Any]] = []
        if root.exists():
            for dirpath, _dirnames, filenames in os.walk(root):
                for name in filenames:
                    full = Path(dirpath) / name
                    rel = full.relative_to(root).as_posix()
                    st = full.stat()
                    result.append({"rel": rel, "name": rel.split("/")[-1], "size": st.st_size, "mtime": st.st_mtime})
        result.sort(key=lambda r: r["rel"])
        return result

    def upload_files(self, kb_id: str, files: list[tuple[str, bytes]]) -> dict[str, Any]:
        """写入上传文件（复制到 files/，保留相对路径）后重建该 KB 索引（变更+重建一体）。

        写盘前统一校验扩展名白名单（ALLOWED_EXTS，与前端 KB_ALLOWED_EXTS 同步）：
        任一文件不合规即整体拒绝（ValueError → 路由 400），避免半批落盘。
        """
        kb = self._ensure_kb(kb_id)

        # 预校验：路径规范化 + 扩展名白名单；offenders 非空则整批拒绝
        offenders: list[str] = []
        validated: list[tuple[str, bytes]] = []
        for rel, data in files:
            rel = safe_rel_path(rel)
            ext = Path(rel).suffix.lower()
            if ext not in ALLOWED_EXTS:
                offenders.append(f"{rel}（{ext or '无扩展名'}）")
            else:
                validated.append((rel, data))
        if offenders:
            allowed = "、".join(sorted(ALLOWED_EXTS))
            raise ValueError(f"不支持的文件格式：{'、'.join(offenders)}。仅支持：{allowed}")
        if not validated:
            raise ValueError("未收到有效文件")

        files_root = kb.cfg.files_dir
        files_root.mkdir(parents=True, exist_ok=True)
        written = 0
        for rel, data in validated:
            target = files_root / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            written += 1
        stats = self.reindex_kb(kb_id, incremental=True)
        stats["written"] = written
        self.last_stats = stats
        return stats

    def delete_kb_file(self, kb_id: str, rel: str) -> dict[str, Any]:
        kb = self._ensure_kb(kb_id)
        rel = safe_rel_path(rel)
        target = kb.cfg.files_dir / rel
        if not target.exists() or not target.is_file():
            raise FileNotFoundError(f"文件不存在：{rel}")
        target.unlink()
        parent = target.parent
        while parent != kb.cfg.files_dir:
            try:
                parent.rmdir()
            except OSError:
                break
            parent = parent.parent
        return self.reindex_kb(kb_id)

    # ---------------- 索引 ----------------

    def reindex_kb(self, kb_id: str, incremental: bool = True) -> dict[str, Any]:
        """重建/增量更新单个 KB 索引。返回 {docs, chunks, updated, skipped, removed, failed, elapsed}。"""
        kb = self._ensure_kb(kb_id)
        # 增量需要磁盘既有索引作基线（复用未变文档的 chunk/向量）；
        # 全量重建从头扫库，无需加载。
        if incremental:
            self._load_kb(kb_id)
        t0 = time.time()
        with self._lock:
            inventory = kb.store.scan_library()

            if incremental and kb.store.chunks:
                changed = kb.store.changed_docs(inventory)
                removed = kb.store.removed_docs(inventory)
                if not changed and not removed:
                    kb.indexed = bool(kb.store.chunks)
                    stats = {
                        "docs": len(inventory),
                        "chunks": len(kb.store.chunks),
                        "updated": 0,
                        "skipped": len(inventory),
                        "removed": 0,
                        "failed": 0,
                        "elapsed": 0.0,
                    }
                    return stats
            else:
                changed = list(inventory)
                removed = []

            embed_fn = self.embedder.embed if self.embedder.available() else None

            # 1) 新增/变更文档切分
            new_chunks: list = []
            failed = 0
            for doc in changed:
                try:
                    new_chunks.extend(self._chunk_file(kb, doc, embed_fn))
                except Exception as e:
                    failed += 1
                    logger.warning("knowledge chunk failed kb=%s doc=%s: %s", kb_id, doc, e)

            # 2) 未变文档沿用既有 chunk 与向量
            if incremental and kb.store.chunks:
                changed_ids = set(changed) | set(removed)
                kept = [c for c in kb.store.chunks if c.doc_id not in changed_ids]
                old_vecs = kb.store.vectors
                if old_vecs is not None and kept:
                    kept_vecs = [old_vecs[kb.store.position_of[c.chunk_id]] for c in kept
                                 if c.chunk_id in kb.store.position_of]
                else:
                    kept_vecs = []
            else:
                kept, kept_vecs = [], []

            # 既有 chunk 无向量可复用（历史向量缺失/降级重建过）且 embedding 可用 →
            # 一并重嵌，保证 vectors 行数与 all_chunks 对齐（否则向量检索取错文档）。
            if incremental and kept and not kept_vecs and embed_fn is not None:
                kept_vecs = embed_fn([c.text for c in kept])

            # 3) 新 chunk 向量 + 对齐
            all_chunks = kept + new_chunks
            if new_chunks and embed_fn is not None:
                new_vecs = embed_fn([c.text for c in new_chunks])
                if kept_vecs:
                    vectors = np.concatenate([np.asarray(kept_vecs), np.asarray(new_vecs)], axis=0)
                else:
                    vectors = np.asarray(new_vecs)
            elif kept_vecs:
                vectors = np.concatenate([np.asarray(kept_vecs)], axis=0) if kept_vecs else None
            else:
                vectors = None
            vectors = np.ascontiguousarray(vectors, dtype=np.float32) if vectors is not None else None

            for i, c in enumerate(all_chunks):
                c.position = i

            # 4) 重建检索器 + 落盘
            kb.bm25.build(all_chunks)
            if vectors is not None and len(vectors) > 0:
                kb.vector.build(vectors)
                kb.vector.save(kb.cfg.faiss_path)

            new_meta = dict(kb.store.doc_meta)
            for doc in changed:
                new_meta[doc] = inventory[doc]
            for doc in removed:
                new_meta.pop(doc, None)

            kb.store.chunks = all_chunks
            kb.store.vectors = vectors
            kb.store.position_of = {c.chunk_id: i for i, c in enumerate(all_chunks)}
            kb.store.doc_meta = new_meta
            kb.store.save_index(all_chunks, vectors, new_meta)
            kb.indexed = bool(all_chunks)
            kb.loaded = True

            elapsed = time.time() - t0
            stats = {
                "docs": len(inventory),
                "chunks": len(all_chunks),
                "updated": len(changed),
                "skipped": len(inventory) - len(changed),
                "removed": len(removed),
                "failed": failed,
                "elapsed": round(elapsed, 3),
            }
            return stats

    def reindex(self, incremental: bool = True) -> dict[str, Any]:
        """重建全部 KB（兼容旧端点 / 自测）。"""
        stats_list = [self.reindex_kb(r["id"], incremental=incremental) for r in self.registry.list()]
        if not stats_list:
            return {"docs": 0, "chunks": 0, "updated": 0, "skipped": 0, "removed": 0, "failed": 0, "elapsed": 0.0}
        return {
            "docs": sum(s["docs"] for s in stats_list),
            "chunks": sum(s["chunks"] for s in stats_list),
            "updated": sum(s["updated"] for s in stats_list),
            "skipped": sum(s["skipped"] for s in stats_list),
            "removed": sum(s["removed"] for s in stats_list),
            "failed": sum(s["failed"] for s in stats_list),
            "elapsed": round(sum(s["elapsed"] for s in stats_list), 3),
        }

    def _chunk_file(self, kb: _KbIndex, doc: str, embed_fn) -> list:
        """读取并切分单个文档：按扩展名提取文本（extract.py）→ chunker 结构切分。

        html/htm 走结构解析；txt/md 纯文本；csv/json 转结构化行；pdf/docx 抽取文本。
        提取失败抛 ValueError，由 reindex_kb 计入 stats.failed。
        """
        full = kb.cfg.library_dir / doc
        data = full.read_bytes()
        if not data.strip():
            return []
        content = extract_document(doc, data)
        if not content or not content.strip():
            return []
        return chunk_document(doc, content, embed_fn, kb.cfg)

    # ---------------- 检索 ----------------

    def search(self, query: str, *, kb_id: str | None = None, top_n: int | None = None) -> list[SearchResult]:
        """完整检索链路：kb_id 给定只搜该 KB；缺省搜全部 indexed KB 后按分数合并。"""
        q = (query or "").strip()
        if not q:
            return []
        if kb_id:
            kb = self._load_kb(kb_id)
            if not kb.indexed or not kb.store.chunks:
                return []
            return self._search_kb(kb, q, top_n=top_n)
        final_top = top_n if top_n is not None else self.cfg.final_top
        merged: list[SearchResult] = []
        for rec in self.registry.list():
            kb = self._load_kb(rec["id"])
            if not kb.indexed or not kb.store.chunks:
                continue
            merged.extend(self._search_kb(kb, q, top_n=max(final_top, self.cfg.final_top_max)))
        merged.sort(key=lambda r: r.score, reverse=True)
        return merged[:final_top]

    def _search_kb(self, kb: _KbIndex, q: str, *, top_n: int | None = None) -> list[SearchResult]:
        """单个 KB 的完整检索链路：BM25(auto) + 精确 BM25 + FAISS → RRF → 去重 → 级联重排。"""
        with self._lock:  # 快照，避免与 reindex 竞态
            chunks = list(kb.store.chunks)
            vectors = kb.store.vectors
            position_of = dict(kb.store.position_of)

        # 1) 混合召回
        qt = tokenize(q)
        bm25_hits = kb.bm25.search(qt, top_k=self.cfg.bm25_top_k)
        result_sets = [bm25_hits]
        engine_sets: dict[str, set[str]] = {"bm25": {cid for cid, _ in bm25_hits}}

        exact_tokens = self._exact_query_tokens(q)
        if exact_tokens:
            exact_hits = kb.bm25.search(exact_tokens, top_k=self.cfg.bm25_top_k, exact=True)
            if exact_hits:
                result_sets.append(exact_hits)
                engine_sets["exact"] = {cid for cid, _ in exact_hits}

        if vectors is not None and len(vectors) > 0 and self.embedder.available():
            qv = self.embedder.embed_query(q)
            positions, scores = kb.vector.search(qv, top_k=self.cfg.vector_top_k)
            vector_hits = [
                (chunks[p].chunk_id, s)
                for p, s in zip(positions, scores)
                if 0 <= p < len(chunks)
            ]
            if vector_hits:
                result_sets.append(vector_hits)
                engine_sets["vector"] = {cid for cid, _ in vector_hits}

        # 2) RRF 融合 + 去重
        fused = dedupe(result_sets, kb.cfg, position_of, vectors)
        candidates = fused[: kb.cfg.rrf_candidates]
        if not candidates:
            return []
        cand_chunks = [chunks[position_of[cid]] for cid, _ in candidates]

        # 3) 级联重排；候选数 ≤ final_top 时跳过——RRF 顺序即最终集合，重排无法再少选
        final_top = top_n if top_n is not None else kb.cfg.final_top
        if len(cand_chunks) <= final_top:
            rrf_scores = dict(candidates)
            reranked = [(chunk, rrf_scores.get(chunk.chunk_id, 0.0)) for chunk in cand_chunks]
        else:
            reranked = self.reranker.rerank(q, cand_chunks, final_top=final_top)

        # 4) 组装
        results: list[SearchResult] = []
        for rank, (chunk, score) in enumerate(reranked, start=1):
            sources = [k for k, ids in engine_sets.items() if chunk.chunk_id in ids]
            results.append(
                SearchResult(
                    chunk_id=chunk.chunk_id,
                    doc_id=chunk.doc_id,
                    text=chunk.text,
                    section=chunk.section,
                    score=round(float(score), 4),
                    rank=rank,
                    sources=sources or ["rrf"],
                )
            )
        return results

    def _exact_query_tokens(self, query: str) -> list[str] | None:
        """精确匹配配置的 query token：引号短语优先，其次纯标识符。无触发返回 None。"""
        quoted = extract_quoted(query)
        if quoted:
            tokens = tokenize(quoted)
        elif looks_like_identifier(query):
            tokens = tokenize(query)
        else:
            return None
        return tokens or None

    # ---------------- 生成 ----------------

    def query(self, query: str, *, kb_id: str | None = None, provider: str | None = None, depth: str | None = None,
              top_n: int | None = None) -> dict[str, Any]:
        """检索 + LLM 生成。返回 {answer, citations}。LLM 未配置时抛 KeyError/LLMError（路由转 503）。"""
        results = self.search(query, kb_id=kb_id, top_n=top_n)
        if not results:
            return {"answer": "知识库中未检索到相关内容。", "citations": []}

        # provider/depth 校验：不在配置内回退默认，避免 router.get 抛 KeyError
        if provider not in self.ctx_cfg.providers:
            provider = None
        if depth not in ("fast", "deep"):
            depth = None
        provider = provider or self.ctx_cfg.default_provider
        depth = depth or self.ctx_cfg.default_depth
        client = self.router.get(provider, depth)  # provider 配置缺 key/模型 → KeyError

        blocks: list[str] = []
        for i, r in enumerate(results, start=1):
            loc = f"{r.doc_id}" + (f" · {r.section}" if r.section else "")
            blocks.append(f"[引用{i}]（来源 {loc}）\n{r.text}")
        context = "\n\n".join(blocks)
        if len(context) > self.cfg.gen_max_chars:
            context = context[: self.cfg.gen_max_chars] + "\n[上下文过长已截断]"

        prompt = render_prompt("rag_answer.md", context=context, query=query)
        answer = client.chat([{"role": "user", "content": prompt}])

        citations = [
            {
                "chunk_id": r.chunk_id,
                "doc_id": r.doc_id,
                "section": r.section,
                "text": r.text[:2000],
                "score": r.score,
                "rank": r.rank,
                "sources": r.sources,
            }
            for r in results
        ]
        return {"answer": answer, "citations": citations}

    # ---------------- 状态 ----------------

    def status(self) -> dict[str, Any]:
        """索引状态（不触发重建，读注册表 + KB 摘要）：UI 列表数据源。"""
        with self._lock:
            kbs = self.list_kbs()
            return {
                "available": self.available,
                "indexed": any(k["indexed"] for k in kbs),
                "kbs": kbs,
                "embed_model": self.cfg.embed_model,
                "last_error": self.last_error,
                "last_stats": self.last_stats or None,
            }

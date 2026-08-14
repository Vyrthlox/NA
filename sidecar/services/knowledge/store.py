"""知识库存储：chunk 清单 + 向量 + 文档清单（增量 reindex 依据）。

磁盘布局（data/knowledge/）：
- chunks.jsonl   每行一个 Chunk.to_dict()，与向量数组位置对齐
- faiss.index    FAISS 索引（faiss 可用时）
- faiss.npy      全量向量副本（numpy 兜底检索 / 去重复用 / 增量重嵌）
- index_meta.json 文档清单：doc_id -> {mtime, size, chunks}，用于增量跳过未变文档
"""

from __future__ import annotations

import json
import os
from pathlib import Path

import numpy as np

from .config import KnowledgeConfig
from .types import Chunk

# 允许入库的文档格式（上传白名单 = 索引扫描白名单，单一事实来源）：
# 常用文档 docx/pdf（二进制，抽取文本后入库）+ 纯文本 txt/md/csv/json + 网页 html/htm
ALLOWED_EXTS = {".docx", ".pdf", ".txt", ".md", ".csv", ".json", ".html", ".htm"}

# 兼容旧名（历史代码引用）
_INDEX_EXTS = ALLOWED_EXTS


class KnowledgeStore:
    def __init__(self, cfg: KnowledgeConfig) -> None:
        self.cfg = cfg
        self.chunks: list[Chunk] = []
        self.vectors: np.ndarray | None = None
        self.position_of: dict[str, int] = {}
        self.doc_meta: dict[str, dict] = {}

    # ---------------- 落盘 ----------------

    def save_index(self, chunks: list[Chunk], vectors: np.ndarray | None, doc_meta: dict[str, dict]) -> None:
        """全量写盘：chunks.jsonl + 向量 npy + index_meta.json。"""
        self.cfg.data_dir.mkdir(parents=True, exist_ok=True)
        with open(self.cfg.chunks_path, "w", encoding="utf-8") as f:
            for ch in chunks:
                f.write(json.dumps(ch.to_dict(), ensure_ascii=False) + "\n")
        if vectors is not None:
            np.save(str(self.cfg.faiss_path.with_suffix(".npy")), vectors)
        with open(self.cfg.index_meta_path, "w", encoding="utf-8") as f:
            json.dump(doc_meta, f, ensure_ascii=False, indent=2)

    def load_index(self) -> bool:
        """从磁盘恢复内存状态；不完整（缺 chunks 或向量）返回 False。"""
        self.chunks, self.position_of = [], {}
        self.vectors = None
        self.doc_meta = {}
        if not self.cfg.chunks_path.exists():
            return False
        try:
            with open(self.cfg.chunks_path, "r", encoding="utf-8") as f:
                rows = [json.loads(line) for line in f if line.strip()]
            chunks = [Chunk.from_dict(r) for r in rows]
            npy = self.cfg.faiss_path.with_suffix(".npy")
            vecs = np.load(str(npy)) if npy.exists() else None
            if vecs is not None and vecs.shape[0] != len(chunks):
                vecs = None  # 数量不齐 → 向量不可用（BM25 仍可用）
        except Exception:
            return False
        self.chunks = chunks
        self.vectors = np.ascontiguousarray(vecs, dtype=np.float32) if vecs is not None else None
        self.position_of = {c.chunk_id: i for i, c in enumerate(chunks)}
        if self.cfg.index_meta_path.exists():
            try:
                self.doc_meta = json.loads(self.cfg.index_meta_path.read_text(encoding="utf-8"))
            except Exception:
                self.doc_meta = {}
        return True

    # ---------------- 库扫描 / 增量判定 ----------------

    def scan_library(self) -> dict[str, dict]:
        """扫描 data/library/ 下全部白名单格式（ALLOWED_EXTS），返回 doc_id -> {mtime, size}。

        doc_id = 相对库根的 posix 路径（与 Electron 文件库 id 一致，如 "myTest/1.html"）。
        """
        root = self.cfg.library_dir
        result: dict[str, dict] = {}
        if not root.exists():
            return result
        for dirpath, _dirnames, filenames in os.walk(root):
            for name in filenames:
                ext = Path(name).suffix.lower()
                if ext not in _INDEX_EXTS:
                    continue
                full = Path(dirpath) / name
                rel = full.relative_to(root).as_posix()
                st = full.stat()
                result[rel] = {"mtime": st.st_mtime, "size": st.st_size}
        return result

    def changed_docs(self, inventory: dict[str, dict]) -> list[str]:
        """库中新增/内容有变的文档（mtime 或 size 与上次索引不同）。"""
        return [doc for doc, info in inventory.items() if self.doc_meta.get(doc) != info]

    def removed_docs(self, inventory: dict[str, dict]) -> list[str]:
        """上次索引过、现已从库中删除的文档。"""
        return [doc for doc in self.doc_meta if doc not in inventory]

    def is_stale(self, inventory: dict[str, dict]) -> bool:
        return bool(self.changed_docs(inventory) or self.removed_docs(inventory))

"""RAG 知识库内部数据类型。"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class Chunk:
    """一个检索单元（切分产物）。chunk_id 在 doc 内稳定（doc_path::seq），供去重使用。"""

    chunk_id: str
    doc_id: str  # 相对库根的 posix 路径，如 "myTest/1.html"
    text: str
    tokens: int = 0
    section: str = ""  # 标题层级路径，如 "安装指南 / 依赖"
    seq: int = 0
    # 索引时填充：在 chunks 数组中的位置（与 FAISS 整数 id 对齐）
    position: int = -1
    embedding: list[float] | None = None  # 索引期使用，落盘不序列化（存 FAISS 侧）

    def to_dict(self) -> dict:
        return {
            "chunk_id": self.chunk_id,
            "doc_id": self.doc_id,
            "text": self.text,
            "tokens": self.tokens,
            "section": self.section,
            "seq": self.seq,
            "position": self.position,
        }

    @classmethod
    def from_dict(cls, d: dict) -> "Chunk":
        return cls(
            chunk_id=d.get("chunk_id", ""),
            doc_id=d.get("doc_id", ""),
            text=d.get("text", ""),
            tokens=int(d.get("tokens", 0)),
            section=d.get("section", ""),
            seq=int(d.get("seq", 0)),
            position=int(d.get("position", -1)),
        )


@dataclass
class Hit:
    """检索中间结果：一个候选 chunk 的融合/重排后状态。"""

    chunk: Chunk
    rrf_score: float = 0.0
    bm25_score: float = 0.0
    vector_score: float = 0.0
    exact_score: float = 0.0
    rerank_score: float = 0.0
    final_score: float = 0.0


@dataclass
class SearchResult:
    """检索终态：返回给调用方的一条结果。"""

    chunk_id: str
    doc_id: str
    text: str
    section: str
    score: float
    rank: int
    sources: list[str] = field(default_factory=list)  # 命中来源：bm25/vector/exact/rerank

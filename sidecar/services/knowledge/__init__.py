"""RAG 知识库：文档切分 → 索引（BM25 + FAISS）→ 混合召回 → RRF 融合 → 级联重排 → LLM 生成。

与长期记忆（services/memory）并列，检索/生成链路独立，可单独启用（KNOWLEDGE_ENABLED=0 关闭）。
任何依赖缺失（jieba/faiss/模型）时安全降级，sidecar 整体不受影响（沿 memory 模块惯例）。
"""

from __future__ import annotations

from .service import KnowledgeService  # noqa: F401

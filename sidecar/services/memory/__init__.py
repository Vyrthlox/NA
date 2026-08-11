"""AI 对话长期记忆（Mem0 + 本地向量检索 + 精排）。

职责：
- 抽取：每轮对话完成后，从 dismantled.json 的该轮拆卸内容中，用 llm.py 的 LLMClient
  结构化抽取「值得跨会话保留」的记忆（偏好 / 画像 / 知识 / 任务状态）。
- 存储与检索：Mem0 封装（本地 qdrant on-disk + bge-small-zh 向量 + bge-reranker 精排）。
- 检索注入：混合召回 → cross-encoder 精排 → 业务信号融合 → top-k，
  以 memory_provider 回调注入 ContextManager.assemble_messages 的锚点块之后。
- 沉降：后台单 worker 异步执行，不阻塞 /chat 流式。

约束：记忆抽取复用 llm.py（唯一 LLM 接入点）；Mem0 内部 llm 仅作构造期占位（infer=False）。
"""

from .config import MemoryConfig
from .types import MemoryDraft, MemoryHit
from .store import MemoryStore
from .extraction import MemoryExtractor
from .retrieval import MemoryRetriever
from .service import MemoryService

__all__ = [
    "MemoryConfig",
    "MemoryDraft",
    "MemoryHit",
    "MemoryStore",
    "MemoryExtractor",
    "MemoryRetriever",
    "MemoryService",
]

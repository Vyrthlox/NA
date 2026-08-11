"""NA 对话上下文管理核心。

策略：上下文缩减（reduction）+ 上下文拆卸（dismantling）+ 分级保留（tiered retention）。
- 近期（0~N 轮）：全量保留原文。
- 中期（N~M 轮）：压缩保留 —— 用户意图摘要 + 关键结论，丢弃中间推理。
- 远期（M 轮后）：仅保留事实锚点 —— 用户偏好、已确认的事实。
拆卸产物按对话落盘到 JSON 文件。

对外主要入口见 context_manager.ContextManager。
"""

from .config import SidecarConfig, load_config
from .llm import DeepSeekClient, LLMClient, LLMError, parse_json_like
from .dismantler import Dismantler
from .reducer import Reducer
from .storage import ConversationStorage
from .context_manager import ContextManager
from .thresholds import ThresholdPolicy

__all__ = [
    "SidecarConfig",
    "load_config",
    "LLMClient",
    "DeepSeekClient",
    "LLMError",
    "parse_json_like",
    "Dismantler",
    "Reducer",
    "ConversationStorage",
    "ContextManager",
    "ThresholdPolicy",
]

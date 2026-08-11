"""长期记忆数据契约。"""

from __future__ import annotations

from dataclasses import dataclass

# 记忆业务分类（抽取 taxonomy）
CATEGORY_PREFERENCE = "preference"        # 用户偏好、风格要求、长期约定
CATEGORY_USER_PROFILE = "user_profile"    # 用户身份、职业、客观属性
CATEGORY_KNOWLEDGE = "knowledge"          # 已确认事实、结论、项目信息
CATEGORY_TASK_STATE = "task_state"        # 进行中/待办任务、决策

CATEGORIES = (CATEGORY_PREFERENCE, CATEGORY_USER_PROFILE, CATEGORY_KNOWLEDGE, CATEGORY_TASK_STATE)


@dataclass
class MemoryDraft:
    """抽取产出的一条候选记忆。"""

    text: str
    category: str = CATEGORY_KNOWLEDGE
    importance: int = 3  # 1（可留可删）~ 5（必须记住）


@dataclass
class MemoryHit:
    """检索命中的一条记忆（含业务融合得分）。"""

    memory_id: str
    text: str
    category: str
    importance: int
    scope: str
    source_conversation_id: str
    source_seq: int
    created_at: str
    score: float = 0.0        # mem0 原始融合分（语义+BM25+实体提升）
    rerank_score: float | None = None  # cross-encoder logit（可负）
    final_score: float = 0.0  # 业务融合后得分（用于排序/过滤）

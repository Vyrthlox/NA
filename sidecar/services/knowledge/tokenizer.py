"""中文感知分词：jieba（懒加载，缺失降级字符 bigram）+ 英文/数字 regex 混合。

BM25 的关键词匹配依赖分词质量：中文用 jieba 词切分，英文/数字按连续字母数字串切分，
标点/空白只作分隔。全部 token 小写归一，去除首尾标点残留。
"""

from __future__ import annotations

import re
import threading

# CJK 基本区
_CJK_RE = re.compile(r"[一-鿿]")
# 连续字母数字串（含 _ - . 内部，便于 ID/版本号整体成 token），如 BUG-123 / NA2024 / v1.2.3
_ASCII_TOKEN_RE = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]*")
# 交替提取「CJK 连续串」与「ASCII 字母数字串」，标点/空白作分隔（finditer 不丢弃匹配段）
_SEG_RE = re.compile(r"[一-鿿]+|[a-zA-Z0-9][a-zA-Z0-9_.-]*")

# 标识符型 query 判定：全为 ASCII 段，无 CJK（精确匹配配置的触发条件之一）
_IDENT_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.\-:+/]*$")

_jieba = None
_jieba_ok: bool | None = None
_jieba_lock = threading.Lock()


def _ensure_jieba() -> bool:
    """惰性导入 jieba（首次调用探测）。"""
    global _jieba, _jieba_ok
    if _jieba_ok is not None:
        return _jieba_ok
    with _jieba_lock:
        if _jieba_ok is None:
            try:
                import jieba
                jieba.setLogLevel(60)  # 屏蔽初始化日志
                _jieba = jieba
                _jieba_ok = True
            except Exception:
                _jieba = None
                _jieba_ok = False
    return _jieba_ok


def has_cjk(text: str) -> bool:
    return bool(_CJK_RE.search(text or ""))


def _cjk_bigram(segment: str) -> list[str]:
    """jieba 缺失时的降级分词：相邻两字 bigram（尾部单字补齐）。"""
    seg = segment.strip()
    if not seg:
        return []
    if len(seg) == 1:
        return [seg]
    return [seg[i : i + 2] for i in range(len(seg) - 1)] + ([seg[-1]] if len(seg) % 2 == 0 else [])


def _normalize(token: str) -> str:
    return token.strip("-_.,:;!?()[]{}<>\"'、。，；：！？·—…《》〈〉‘’“”").lower()


def tokenize(text: str) -> list[str]:
    """分词：中文段 jieba 词切（缺失则 bigram），ASCII 段按连续串切，标点/空白为分隔。

    用 finditer 交替提取「CJK 连续串」与「ASCII 字母数字串」，两者都保留（不丢弃）。
    返回小写归一后的 token 列表（空文本 → []）。
    """
    if not text:
        return []
    tokens: list[str] = []
    for m in _SEG_RE.finditer(text):
        tok = m.group(0)
        if _CJK_RE.search(tok):
            # 纯中文串：jieba 词切，缺失降级字符 bigram
            if _ensure_jieba():
                for w in _jieba.cut(tok):
                    t = _normalize(w)
                    if t:
                        tokens.append(t)
            else:
                tokens.extend(_normalize(b) for b in _cjk_bigram(tok))
        else:
            # ASCII 串：整体归一（保留 _-. 内部结构，如 v1.2.3）
            t = _normalize(tok)
            if t:
                tokens.append(t)
    return tokens


def count_tokens(text: str) -> int:
    """token 数估算（与 tokenize 同口径，用于切分窗口/短长判定）。"""
    return len(tokenize(text))


def truncate_to_tokens(text: str, max_tokens: int) -> str:
    """截到约第 max_tokens 个 token 的前缀；不超过上限原样返回，max_tokens≤0 视为不截。

    与 tokenize 同口径估算（CJK 1 字≈1 token，ASCII 按 4 字符≈1 token），逐段消耗预算。
    只用于重排打分的文本上限，无需精确 token 边界——略多/略少 10% 无影响。
    """
    if max_tokens <= 0 or not text:
        return text
    if count_tokens(text) <= max_tokens:
        return text
    budget = max_tokens
    out: list[str] = []
    for m in _SEG_RE.finditer(text):
        seg = m.group(0)
        is_cjk = bool(_CJK_RE.search(seg))
        cost = len(seg) if is_cjk else max(1, len(seg) // 4)  # CJK 1 字≈1 token，ASCII 4 字符≈1 token
        if cost >= budget:
            out.append(seg[:budget] if is_cjk else seg[:max(1, budget * 4)])  # 段内截到剩余预算
            break
        out.append(seg)
        budget -= cost
        if budget <= 0:
            break
    return "".join(out)


def looks_like_identifier(query: str) -> bool:
    """query 是否为「精确标识」：无中文、整串匹配标识符模式（如 NA2024、BUG-123、v1.2.3）。

    命中时 BM25 走 k1=0 精确匹配配置（命中项各计 IDF，强调出现而非词频）。
    """
    q = (query or "").strip()
    if not q or has_cjk(q):
        return False
    return bool(_IDENT_RE.match(q))


def extract_quoted(query: str) -> str | None:
    """提取引号短语 `"..."` / `「...」` / `『...』` 内的内容；无则返回 None。"""
    m = re.search(r"[\"「『]([^\"」』]+)[\"」』]", query or "")
    return m.group(1).strip() if m else None

"""文档切分：HTML（TipTap 片段）→ 块级结构 → 语义校验的 chunk 组装。

策略（用户确认「结构切分 + 语义校验」）：
1. html.parser 提取块级单元（h1~h6 / p / li / blockquote / pre），剥 script/style；
2. 块按 token 数组装成 256~512 的 chunk，H1/H2 结构性硬切；
3. chunk 累积到 min_tokens 后，每并入下一块前用「当前累积文本」与「新块」的
   embedding 余弦，低于阈值视为主题突变 → 强制切分；
4. 单块超 max_tokens 按句切 + overlap 滑窗。
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from html.parser import HTMLParser
from typing import Callable

import numpy as np

from .config import KnowledgeConfig
from .tokenizer import count_tokens
from .types import Chunk

# 块级边界标签：这些标签的开/闭都会刷新当前缓冲
_BLOCK_TAGS = {
    "h1", "h2", "h3", "h4", "h5", "h6",
    "p", "div", "li", "blockquote", "pre", "tr", "section", "article",
    "table", "ul", "ol", "dl", "dd", "dt", "form", "figure", "figcaption",
}
_IGNORE_TAGS = {"script", "style", "head", "noscript", "template"}
_HEADING_LEVELS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}

EmbedFn = Callable[[list[str]], np.ndarray]


@dataclass
class Block:
    """一个块级单元。level=0 为普通内容，1~6 为标题层级。"""

    level: int
    kind: str  # h / p / li / quote / pre / plain
    text: str


def _collapse(text: str) -> str:
    """折叠空白：连续空格→单空格，换行保留但连续换行→单换行，去首尾。"""
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n+", "\n", text)
    return text.strip()


class _BlockExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.blocks: list[Block] = []
        self._buf: list[str] = []
        self._ignore_depth = 0
        self._current_kind = "plain"
        self._current_level = 0

    def _flush(self) -> None:
        text = _collapse("".join(self._buf))
        self._buf = []
        if not text:
            return
        self.blocks.append(Block(level=self._current_level, kind=self._current_kind, text=text))
        self._current_kind = "plain"
        self._current_level = 0

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in _IGNORE_TAGS:
            self._ignore_depth += 1
            return
        if tag == "br":
            self._buf.append("\n")
            return
        if tag in _BLOCK_TAGS:
            self._flush()
            self._current_kind = tag
            self._current_level = _HEADING_LEVELS.get(tag, 0)
            return
        # 其余为行内标签：内容照常累积到当前缓冲

    def handle_endtag(self, tag: str) -> None:
        if tag in _IGNORE_TAGS:
            self._ignore_depth = max(0, self._ignore_depth - 1)
            return
        if tag == "br":
            return
        if tag in _BLOCK_TAGS:
            self._flush()

    def handle_data(self, data: str) -> None:
        if self._ignore_depth == 0:
            self._buf.append(data)


def extract_blocks(html: str) -> list[Block]:
    """把 HTML 片段解析为块级单元列表（空/纯空白块已剔除）。"""
    parser = _BlockExtractor()
    try:
        parser.feed(html or "")
        parser.close()
    except Exception:
        # 解析失败不阻断：退化为整段文本单块
        text = _collapse(re.sub(r"<[^>]+>", " ", html or ""))
        return [Block(level=0, kind="plain", text=text)] if text else []
    parser._flush()
    return parser.blocks


def _split_sentences(text: str) -> list[str]:
    """按中文/英文句读拆句（保留分隔符），供超长块切窗。"""
    parts = re.split(r"(?<=[。！？!?；;.\n])\s*", text)
    return [p.strip() for p in parts if p and p.strip()]


def _split_long_text(text: str, max_tokens: int, cfg: KnowledgeConfig) -> list[str]:
    """单个超长块按句切 + overlap 滑窗，返回若干段（每段 ≤ max_tokens）。

    实现：贪心把句子装进窗口，超出上限即封窗；下一窗以本窗尾部约 overlap token 重启。
    """
    sentences = _split_sentences(text)
    # 极端：一句就超 max_tokens → 按字符硬切（带 overlap），避免死循环
    hard: list[str] = []
    windows: list[str] = []

    def push_window(window: list[str], total: int) -> None:
        if not window:
            return
        t = "\n".join(window)
        # 兜底：若窗口仍超限（句子过长合并导致），按字符硬切
        if total > max_tokens:
            hard.append(t)
        else:
            windows.append(t)

    i, window, total = 0, [], 0
    while i < len(sentences):
        s = sentences[i]
        st = count_tokens(s)
        if st > max_tokens:
            # 单句超限：先把当前窗收掉，再按字符硬切这句
            push_window(window, total)
            window, total = [], 0
            hard.append(_hard_split(s, max_tokens, cfg.chunk_overlap_tokens))
            i += 1
            continue
        if total + st > max_tokens and window:
            push_window(window, total)
            # 新窗从上一窗尾部保留约 overlap token 的句子开始（重叠）
            window, total = [], 0
            for w in reversed(windows[-1].split("\n")):
                if total + count_tokens(w) > cfg.chunk_overlap_tokens:
                    break
                window.insert(0, w)
                total += count_tokens(w)
            continue
        window.append(s)
        total += st
        i += 1
    push_window(window, total)

    out = list(windows)
    for h in hard:
        out.extend(h if isinstance(h, list) else [h])
    return out


def _hard_split(text: str, max_tokens: int, overlap: int) -> list[str]:
    """字符级硬切（仅兜底）：按 token 上限分段并带 overlap。"""
    if count_tokens(text) <= max_tokens:
        return [text]
    # 用字符粒度近似 token，保证不超 max_tokens
    per = max(1, int(len(text) * max_tokens / max(1, count_tokens(text))))
    step = max(1, per - overlap)
    pieces: list[str] = []
    i = 0
    while i < len(text):
        piece = text[i : i + per]
        if not piece:
            break
        pieces.append(piece)
        i += step
    return pieces


def _cos(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.dot(a, b).item())  # 已归一化，内积即余弦


class _SectionTracker:
    """标题层级栈 → section 路径（"父标题 / 子标题"）。"""

    def __init__(self) -> None:
        self._stack: list[tuple[int, str]] = []

    def update(self, block: Block) -> None:
        if block.level <= 0:
            return
        while self._stack and self._stack[-1][0] >= block.level:
            self._stack.pop()
        self._stack.append((block.level, block.text))

    def path(self) -> str:
        return " / ".join(t for _, t in self._stack)


def chunk_document(
    doc_id: str,
    html: str,
    embed_fn: EmbedFn | None,
    cfg: KnowledgeConfig,
) -> list[Chunk]:
    """把一个文档切成 chunk 列表。embed_fn 可为 None（无 embedding 时纯结构切分）。

    chunk_id = "{doc_id}::{seq}"，doc 内 seq 稳定递增（reindex 后可复现，供去重）。
    """
    blocks = extract_blocks(html)
    if not blocks:
        return []

    chunks: list[Chunk] = []
    tracker = _SectionTracker()
    cur: list[Block] = []
    cur_text = ""
    cur_tokens = 0

    def flush() -> None:
        nonlocal cur, cur_text, cur_tokens
        if not cur:
            return
        seq = len(chunks)
        chunks.append(
            Chunk(
                chunk_id=f"{doc_id}::{seq}",
                doc_id=doc_id,
                text=cur_text.strip(),
                tokens=cur_tokens,
                section=tracker.path(),
                seq=seq,
            )
        )
        cur, cur_text, cur_tokens = [], "", 0

    for block in blocks:
        tracker.update(block)
        bt = count_tokens(block.text)
        if bt <= 0:
            continue

        # 单块超上限：先收当前，再按句切窗
        if bt > cfg.chunk_max_tokens:
            flush()
            for piece in _split_long_text(block.text, cfg.chunk_max_tokens, cfg):
                seq = len(chunks)
                chunks.append(
                    Chunk(
                        chunk_id=f"{doc_id}::{seq}",
                        doc_id=doc_id,
                        text=piece,
                        tokens=count_tokens(piece),
                        section=tracker.path(),
                        seq=seq,
                    )
                )
            continue

        # 结构性硬切：H1/H2 标题开始新章节
        if block.level in (1, 2) and cur_tokens > 0:
            flush()

        # 语义校验切分：累积 ≥min 后，与下一块主题突变则切
        if embed_fn is not None and cur_tokens >= cfg.chunk_min_tokens:
            try:
                acc_vec = embed_fn([cur_text])[0]
                blk_vec = embed_fn([block.text])[0]
                if _cos(acc_vec, blk_vec) < cfg.sem_threshold:
                    flush()
            except Exception:
                pass  # embedding 失败时退化为纯结构切分

        # 容量限制：加不进去且已有内容则切
        if cur_tokens > 0 and cur_tokens + bt > cfg.chunk_max_tokens:
            flush()

        cur.append(block)
        cur_text = (cur_text + "\n" if cur_text else "") + block.text
        cur_tokens += bt

    flush()
    return chunks

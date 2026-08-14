"""知识库文档文本提取：上传文件 → 供 chunker 结构切分的 HTML 片段。

支持格式（与 store.ALLOWED_EXTS 一致）：
- .html / .htm → 原样透传（chunker 解析 h1-h6/p/li 等结构）
- .txt / .md   → 解码后 escape 包 <p>（纯文本语义，与历史行为一致）
- .csv         → csv.reader 逐行，每行 `<p>cell | cell</p>`
                 （chunker 的 td 是行内标签，<table> 会黏连单元格，故用行式；
                 与 context/attachment_reader 的 xlsx 读取器同款「 | 」约定）
- .json        → json.loads 美化（indent=2）包 <pre>；解析失败回退原文 <p>
- .pdf         → pypdf 逐页提取，每页 `<section><h2>第 N 页</h2><p>…</p></section>`
- .docx        → python-docx：Heading 样式映射 h1-h6，其余段落 <p>；表格按行 `<p>cell | cell</p>`

错误语义：可提取内容为空 / 解析库缺失 / 文件损坏一律抛 ValueError，
由 reindex_kb 的 try/except 捕获计入 stats.failed 并告警，不中断整批。
解码回退链 utf-8 → gb18030 → latin-1（latin-1 必成，纯文本不会因编码失败）。
"""

from __future__ import annotations

import csv
import html as _html
import io
import json
from pathlib import Path

# 支持格式 → 提取器 的分派表在文件底部定义（_EXTRACTORS）。


def _decode_bytes(data: bytes) -> str:
    for enc in ("utf-8", "gb18030", "latin-1"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    return ""


def extract_html(data: bytes) -> str:
    """HTML/HTM：解码后原样返回，chunker 做结构解析。"""
    return _decode_bytes(data)


def extract_plain(data: bytes) -> str:
    """TXT/MD：escape 后包 <p>，保留换行（chunker 按 \\n 拆句）。MD 标注符号按普通文本保留。"""
    text = _decode_bytes(data)
    if not text.strip():
        raise ValueError("文件内容为空")
    return f"<p>{_html.escape(text)}</p>"


def extract_csv(data: bytes) -> str:
    """CSV：逐行转 `<p>cell | cell</p>`；空行跳过。"""
    text = _decode_bytes(data)
    if not text.strip():
        raise ValueError("CSV 内容为空")
    rows: list[str] = []
    for row in csv.reader(io.StringIO(text)):
        cells = [c.strip() for c in row if c is not None and c.strip() != ""]
        if cells:
            rows.append(f"<p>{_html.escape(' | '.join(cells))}</p>")
    if not rows:
        raise ValueError("CSV 无有效行")
    return "\n".join(rows)


def extract_json(data: bytes) -> str:
    """JSON：可解析则美化后包 <pre>；解析失败回退原文 <p>（仍是有效文本资料）。"""
    text = _decode_bytes(data)
    if not text.strip():
        raise ValueError("JSON 内容为空")
    try:
        obj = json.loads(text)
        pretty = json.dumps(obj, ensure_ascii=False, indent=2)
        return f"<pre>{_html.escape(pretty)}</pre>"
    except (json.JSONDecodeError, ValueError):
        return f"<p>{_html.escape(text)}</p>"


def extract_pdf(data: bytes) -> str:
    """PDF：pypdf 逐页提取文本；缺库 / 损坏 / 无文本抛 ValueError。"""
    try:
        from pypdf import PdfReader
    except ImportError as e:
        raise ValueError("pypdf 未安装，无法解析 PDF") from e
    try:
        reader = PdfReader(io.BytesIO(data))
    except Exception as e:
        raise ValueError(f"PDF 解析失败：{e}") from e
    sections: list[str] = []
    for i, page in enumerate(reader.pages, start=1):
        try:
            text = (page.extract_text() or "").strip()
        except Exception:
            continue
        if text:
            sections.append(f"<section><h2>第 {i} 页</h2><p>{_html.escape(text)}</p></section>")
    if not sections:
        raise ValueError("PDF 无可提取文本")
    return "\n".join(sections)


def extract_docx(data: bytes) -> str:
    """DOCX：段落（Heading 样式 → h1-h6）+ 表格行（cell | cell）。"""
    try:
        from docx import Document
    except ImportError as e:
        raise ValueError("python-docx 未安装，无法解析 DOCX") from e
    try:
        doc = Document(io.BytesIO(data))
    except Exception as e:
        raise ValueError(f"DOCX 解析失败：{e}") from e

    parts: list[str] = []
    for para in doc.paragraphs:
        text = (para.text or "").strip()
        if not text:
            continue
        style = getattr(para.style, "name", "") or ""
        if style.lower().startswith("heading"):
            tail = style.split()[-1]
            level = int(tail) if tail.isdigit() else 2
            level = max(1, min(level, 6))
            parts.append(f"<h{level}>{_html.escape(text)}</h{level}>")
        else:
            parts.append(f"<p>{_html.escape(text)}</p>")
    for table in doc.tables:
        for row in table.rows:
            cells = [(cell.text or "").strip() for cell in row.cells]
            cells = [c for c in cells if c]
            if cells:
                parts.append(f"<p>{_html.escape(' | '.join(cells))}</p>")
    if not parts:
        raise ValueError("DOCX 无可提取内容")
    return "\n".join(parts)


_EXTRACTORS = {
    ".html": extract_html,
    ".htm": extract_html,
    ".txt": extract_plain,
    ".md": extract_plain,
    ".csv": extract_csv,
    ".json": extract_json,
    ".pdf": extract_pdf,
    ".docx": extract_docx,
}


def extract_document(rel_path: str, data: bytes) -> str:
    """按扩展名分派提取器，返回 HTML 片段；不支持 / 提取失败抛 ValueError。"""
    ext = Path(rel_path).suffix.lower()
    extractor = _EXTRACTORS.get(ext)
    if extractor is None:
        raise ValueError(f"不支持的文件格式：{ext or rel_path}")
    return extractor(data)

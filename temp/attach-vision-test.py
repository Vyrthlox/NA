"""多模态 payload 结构直测：image parts 组装 + 消息 content 结构，不依赖网络/LLM。
运行：PYTHONIOENCODING=utf-8 python temp/attach-vision-test.py
"""
import base64
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
ATT = REPO / "temp" / "attach-vision" / "conversations" / "v-conv" / "attachments"
ATT.mkdir(parents=True, exist_ok=True)

# 1x1 红色 PNG（真实可解码）
png = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)
(ATT / "img1.png").write_bytes(png)
(ATT / "doc1.md").write_text("# 视觉测试文档\n\n这里有一段文字。", encoding="utf-8")

meta = {
    "conversation_id": "v-conv",
    "attachments": [
        {"id": "i1", "name": "img1.png", "size": len(png), "mime": "image/png", "stored_name": "img1.png", "uploaded_at": 1},
        {"id": "d1", "name": "doc1.md", "size": 10, "mime": "text/markdown", "stored_name": "doc1.md", "uploaded_at": 1},
    ],
}
(ATT / "attachments.json").write_text(json.dumps(meta, ensure_ascii=False), encoding="utf-8")

sys.path.insert(0, str(REPO))
from sidecar.services.context.attachment_reader import build_attachment_context, build_image_parts  # noqa: E402
from sidecar.services.context.config import load_config  # noqa: E402
from sidecar.services.context.context_manager import ContextManager  # noqa: E402

conversations_dir = ATT.parents[1]

# --- 1. build_image_parts：只取图片，产出 data URL parts ---
parts, embedded = build_image_parts(conversations_dir, "v-conv", ["i1", "d1"])
assert len(parts) == 1, f"应只有 1 个图片 part：{parts}"
assert parts[0]["type"] == "image_url"
url = parts[0]["image_url"]["url"]
assert url.startswith("data:image/png;base64,"), url[:50]
assert embedded == {"i1"}, embedded

# --- 2. build_attachment_context：已嵌入图片标注，md 文本仍注入 ---
ctx = build_attachment_context(conversations_dir, "v-conv", ["i1", "d1"], embedded_image_ids=embedded)
assert "图像已随消息输入" in ctx, ctx
assert "这里有一段文字" in ctx, ctx
assert "仅引用" not in ctx, ctx

# --- 3. 无图时不带 embedded 标注 → 图片回到「仅引用」说明 ---
ctx_no_img = build_attachment_context(conversations_dir, "v-conv", ["i1", "d1"])
assert "仅引用" in ctx_no_img and "图像已随消息输入" not in ctx_no_img, ctx_no_img

# --- 4. assemble_messages：有图时 content 为 parts 数组，无图时纯字符串 ---
cm = ContextManager(load_config())  # 构造不触发网络调用
msgs = cm.assemble_messages(pending_user_text="图里写了什么？", attachment_context=ctx, image_parts=parts)
last = msgs[-1]
assert isinstance(last["content"], list), type(last["content"])
assert last["content"][0]["type"] == "text"
assert last["content"][0]["text"].startswith("[本次对话附带文件]"), last["content"][0]["text"][:40]
assert last["content"][1]["type"] == "image_url"
# 文本 part 含提问，图片 part 是 base64 data URL
assert "图里写了什么？" in last["content"][0]["text"]

msgs2 = cm.assemble_messages(pending_user_text="没有图")
assert isinstance(msgs2[-1]["content"], str), type(msgs2[-1]["content"])
assert msgs2[-1]["content"] == "没有图"

# --- 5. 无附件 id 时为空 ---
parts0, embedded0 = build_image_parts(conversations_dir, "v-conv", [])
assert parts0 == [] and embedded0 == set()

print("=== 多模态 payload 结构断言 ===")
print(f"image parts: {len(parts)} | embedded ids: {sorted(embedded)}")
print(f"data URL 前缀: {url[:30]}…")
print("文本块标注「图像已随消息输入」: OK | md 文本注入: OK | 无图时「仅引用」: OK")
print("多模态 user content = [text, image_url]: OK | 无图纯字符串: OK")
print("全部通过 ✅")

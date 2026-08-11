"""POST /chat —— 流式对话（SSE）。

请求：{"conversation_id": "...", "message": "...", "provider": "deepseek|qwen", "depth": "fast|deep", "attachment_ids": ["..."]}
  - conversation_id 缺省时服务端新建并回传。
  - provider 可选：模型提供商（deepseek 文本 / qwen 视觉），默认 deepseek；非法值回退。
  - depth 可选：深度档位（fast 快速 / deep 深度），默认 fast；决定各 provider 的 fast/deep 模型。
  - attachment_ids 可选：本消息附带的附件 id 列表（txt/md/html/pdf/docx/xlsx 提取文本；
    png/jpg/jpeg 以 image_url content-part 传给视觉模型，超出体积/数量上限则降级仅引用，
    见 attachment_reader）。带图消息默认 provider=qwen、depth=fast（qwen3.7-plus）。
响应：text/event-stream，命名事件：
  event: meta   {conversation_id, provider, depth, model, ...}  会话建立
  event: chunk  {content: "..."}                流式增量
  event: done   {conversation_id, reply, tier_counts, context_path, dismantled_path}  收尾
  event: error  {error: "..."}                  出错
"""

from __future__ import annotations

import json

from flask import Blueprint, Response, current_app, jsonify, request, stream_with_context

from sidecar.registry import get_or_create_conversation
from sidecar.services.context.attachment_reader import build_attachment_context, build_image_parts

bp = Blueprint("chat", __name__)


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


def _is_image_rejection(err: Exception) -> bool:
    """判断错误是否指向「模型/端点不接受图片输入」（如误配成纯文本模型）。

    命中后由调用方剥离图片、降级为文本引用重试一次，避免整个对话失败。
    """
    text = str(err).lower()
    return any(k in text for k in ("image", "vision", "multimodal", "content type", "unprocessable", "media"))


@bp.post("/chat")
def chat():
    payload = request.get_json(silent=True) or {}
    message = (payload.get("message") or "").strip()
    if not message:
        return jsonify({"error": "message 不能为空"}), 400

    # 模型选择：provider（deepseek/qwen，默认 deepseek）× 深度档位（fast/deep，默认 fast）
    provider = payload.get("provider") or "deepseek"
    if provider not in ("deepseek", "qwen"):
        provider = "deepseek"
    depth = payload.get("depth") or "fast"
    if depth not in ("fast", "deep"):
        depth = "fast"

    # 附件 id 列表（可选）：本消息附带文件，读取内容拼入上下文
    attachment_ids = payload.get("attachment_ids")
    if not isinstance(attachment_ids, list) or not all(isinstance(i, str) for i in attachment_ids):
        attachment_ids = []

    cm, _is_new = get_or_create_conversation(current_app, payload.get("conversation_id"))
    conversations_dir = current_app.config["CTX_CFG"].conversations_dir

    # 图片随本轮消息作为 image_url parts 传入视觉模型；文本块标注已嵌入的图片，
    # 其余附件（文本/文档/超限图片）走文本提取或引用说明。
    image_parts, embedded_image_ids = build_image_parts(conversations_dir, cm.conversation_id, attachment_ids)
    attachment_context = build_attachment_context(
        conversations_dir, cm.conversation_id, attachment_ids, embedded_image_ids=embedded_image_ids
    )
    messages, user_dismantled = cm.prepare_turn(
        message, attachment_context=attachment_context, image_parts=image_parts
    )

    # 带图消息默认走 Qwen·快速（qwen3.7-max，视觉模型）：保证图片必达视觉端点。
    # 内部上下文操作（拆卸/缩减/记忆）仍固定用 DeepSeek fast，不受此选择影响。
    effective_provider, effective_depth = provider, depth
    if image_parts:
        effective_provider, effective_depth = "qwen", "fast"
    try:
        chat_llm = cm.llm_for(effective_provider, effective_depth)
    except KeyError as e:
        return jsonify({"error": str(e)}), 400

    def generate():
        yield _sse(
            "meta",
            {
                "conversation_id": cm.conversation_id,
                "n": cm.n,
                "m": cm.m,
                "provider": effective_provider,
                "depth": effective_depth,
                "model": chat_llm.model,
            },
        )
        current_messages = messages
        current_dismantled = user_dismantled
        with_images = bool(image_parts)
        # 最多两次尝试：视觉端点拒绝图片输入（误配纯文本模型）时剥离图片、降级文本引用重试一次
        for _attempt in (1, 2):
            parts: list[str] = []
            try:
                for chunk in chat_llm.stream_chat(current_messages, depth=effective_depth):
                    parts.append(chunk)
                    yield _sse("chunk", {"content": chunk})
            except Exception as e:  # 流中途失败：不回写本轮，仅上报错误
                if with_images and _attempt == 1 and _is_image_rejection(e):
                    current_app.logger.warning("视觉端点拒绝图片输入，剥离图片降级重试：%s", e)
                    text_context = build_attachment_context(conversations_dir, cm.conversation_id, attachment_ids)
                    current_messages, current_dismantled = cm.prepare_turn(
                        message, attachment_context=text_context
                    )
                    with_images = False
                    continue
                current_app.logger.exception("chat stream error")
                yield _sse("error", {"error": str(e)})
                return
            reply = "".join(parts)
            cm.finalize_turn(message, reply, current_dismantled)
            # 每轮完成后异步沉降长期记忆（不阻塞流式；失败仅记录）
            svc = current_app.config.get("MEMORY_SERVICE")
            if svc and svc.enabled:
                try:
                    svc.enqueue_extraction(cm.conversation_id, cm.turns[-1].seq)
                except Exception as e:
                    current_app.logger.warning("memory enqueue failed: %s", e)
            yield _sse(
                "done",
                {
                    "conversation_id": cm.conversation_id,
                    "reply": reply,
                    "tier_counts": cm.tier_counts(),
                    "context_path": str(cm.storage.context_path(cm.conversation_id)),
                    "dismantled_path": str(cm.storage.dismantled_path(cm.conversation_id)),
                },
            )
            return

    # stream_with_context：流式生成器在视图返回后才被消费，期间请求上下文已被弹出，
    # 生成器内的 current_app（日志/异常处理）会报「Working outside of application context」。
    resp = Response(stream_with_context(generate()), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"
    return resp

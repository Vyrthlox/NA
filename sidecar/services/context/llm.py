"""LLM 客户端抽象 + DeepSeek（OpenAI 兼容）实现。

- 缩减 / 拆卸 / 锚点提取等操作通过 chat_json 拿结构化 JSON。
- 后续接服务端大模型时，实现同一 LLMClient 接口替换即可，上层无需改动。
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any, Iterator

import requests

from .config import SidecarConfig

# content 可以是纯字符串，也可以是多模态 parts 数组（OpenAI 兼容 image_url 格式）：
# [{"type": "text", "text": "..."}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}]
Message = dict[str, Any]

# 深度两档（快速/深度）→ 推理强度 / temperature 退化映射。
# 若 API 不认识 reasoning_effort（400），退化为对应 temperature 重试。
DEPTH_EFFORT = {"fast": "low", "deep": "high"}
DEPTH_TEMPERATURE = {"fast": 0.7, "deep": 0.1}
# 首次 400 后置 False，之后所有调用仅用 temperature（避免每次双程）
_REASONING_SUPPORTED = True


class LLMError(Exception):
    """LLM 调用相关错误（网络 / 鉴权 / 格式）。"""


def parse_json_like(text: str | None) -> Any:
    """稳健地解析 LLM 输出的 JSON。

    容忍 markdown 代码块、前后杂讯、尾随文本；失败时抛 LLMError。
    """
    if not text:
        raise LLMError("LLM 返回空内容，无法解析 JSON")
    raw = text.strip()
    # 去掉 ```json ... ``` 代码块围栏
    raw = re.sub(r"^```(?:json)?\s*", "", raw)
    raw = re.sub(r"\s*```$", "", raw)
    # 截取首个 { 到最后一个 }（或首个 [ 到最后一个 ]）
    first, last = raw.find("{"), raw.rfind("}")
    if first == -1 or last == -1 or last <= first:
        first, last = raw.find("["), raw.rfind("]")
    if first == -1 or last == -1 or last <= first:
        raise LLMError(f"LLM 输出中未找到 JSON 结构：{text[:200]}")
    try:
        return json.loads(raw[first : last + 1])
    except json.JSONDecodeError as e:
        raise LLMError(f"LLM 输出 JSON 解析失败：{e}；原文片段：{raw[:200]}") from e


def content_text(content: str | list[dict] | None) -> str:
    """把消息 content 归一化为纯文本：parts 数组时拼接各 text part，字符串原样返回。

    多模态消息的 image_url parts 没有文本，拼接时跳过；用于需要读文本的
    场景（FakeLLMClient 匹配、响应解析兜底），不影响发给 LLM 的原始结构。
    """
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    texts: list[str] = []
    for part in content:
        if isinstance(part, dict) and part.get("type") == "text":
            text = part.get("text")
            if isinstance(text, str):
                texts.append(text)
    return "\n".join(texts)


class LLMClient:
    """对话客户端接口。"""

    def chat(self, messages: list[Message], *, json_mode: bool = False, temperature: float | None = None) -> str:
        raise NotImplementedError

    def chat_json(
        self,
        messages: list[Message],
        *,
        temperature: float | None = None,
    ) -> Any:
        """以 JSON 模式调用并返回解析后的结构。"""
        return parse_json_like(self.chat(messages, json_mode=True, temperature=temperature))

    def stream_chat(self, messages: list[Message], *, temperature: float | None = None, depth: str | None = None) -> Iterator[str]:
        raise NotImplementedError


class DeepSeekClient(LLMClient):
    """DeepSeek（OpenAI 兼容）实现，非流式 + 流式（SSE）。"""

    def __init__(self, config: SidecarConfig) -> None:
        if not config.api_key:
            raise LLMError("未配置 API_KEY：请确认 temp/.env 或环境变量中存在 API_KEY")
        self.api_key = config.api_key
        self.base_url = config.base_url
        self.model = config.model
        self.timeout = config.timeout
        self.json_temperature = config.json_temperature

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    def _payload(self, messages: list[Message], *, json_mode: bool, temperature: float | None, stream: bool, reasoning_effort: str | None = None) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": stream,
            "temperature": temperature if temperature is not None else self.json_temperature,
        }
        if json_mode:
            payload["response_format"] = {"type": "json_object"}
        if reasoning_effort:
            payload["reasoning_effort"] = reasoning_effort
        return payload

    def _post(self, messages: list[Message], *, json_mode: bool, temperature: float | None, stream: bool, reasoning_effort: str | None = None) -> requests.Response:
        url = f"{self.base_url}/chat/completions"
        try:
            return requests.post(
                url,
                headers=self._headers(),
                json=self._payload(messages, json_mode=json_mode, temperature=temperature, stream=stream, reasoning_effort=reasoning_effort),
                timeout=self.timeout,
                stream=stream,
            )
        except requests.RequestException as e:
            raise LLMError(f"请求 LLM 失败（{self.base_url}）：{e}") from e

    def chat(self, messages: list[Message], *, json_mode: bool = False, temperature: float | None = None) -> str:
        resp = self._post(messages, json_mode=json_mode, temperature=temperature, stream=False)
        try:
            resp.raise_for_status()
        except requests.HTTPError as e:
            raise LLMError(f"LLM 返回错误 {resp.status_code}：{resp.text[:300]}") from e
        data = resp.json()
        try:
            # 个别视觉模型响应 content 是 parts 数组，content_text 统一归为纯文本
            return content_text(data["choices"][0]["message"].get("content"))
        except (KeyError, IndexError, TypeError) as e:
            raise LLMError(f"LLM 响应结构异常：{data}") from e

    @staticmethod
    def _is_unknown_field(e: requests.HTTPError, field: str) -> bool:
        resp = e.response
        return bool(resp is not None and resp.status_code == 400 and field in (resp.text or ""))

    @staticmethod
    def _http_error_text(e: requests.HTTPError) -> str:
        resp = e.response
        if resp is not None:
            return f"LLM 返回错误 {resp.status_code}：{resp.text[:300]}"
        return f"LLM 请求失败：{e}"

    def stream_chat(self, messages: list[Message], *, temperature: float | None = None, depth: str | None = None) -> Iterator[str]:
        global _REASONING_SUPPORTED
        # DS 深度三档 → 推理强度 / temperature（API 不支持推理强度字段时退化为 temperature）
        reasoning_effort = None
        if depth and depth in DEPTH_EFFORT:
            reasoning_effort = DEPTH_EFFORT[depth]
            temperature = temperature if temperature is not None else DEPTH_TEMPERATURE[depth]
        if not _REASONING_SUPPORTED:
            reasoning_effort = None
        print(f"[llm] stream model={self.model} depth={depth} reasoning_effort={reasoning_effort} temperature={temperature}", flush=True)

        resp = self._post(messages, json_mode=False, temperature=temperature, stream=True, reasoning_effort=reasoning_effort)
        try:
            resp.raise_for_status()
        except requests.HTTPError as e:
            if reasoning_effort and self._is_unknown_field(e, "reasoning_effort"):
                _REASONING_SUPPORTED = False
                print("[llm] API 不支持 reasoning_effort，退化为 temperature 重试", flush=True)
                resp = self._post(messages, json_mode=False, temperature=temperature, stream=True, reasoning_effort=None)
                try:
                    resp.raise_for_status()
                except requests.HTTPError as e2:
                    raise LLMError(self._http_error_text(e2)) from e2
            else:
                raise LLMError(self._http_error_text(e)) from e
        for line in resp.iter_lines(decode_unicode=True):
            if not line or not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if payload == "[DONE]":
                break
            try:
                obj = json.loads(payload)
                delta = obj["choices"][0].get("delta", {})
            except (json.JSONDecodeError, KeyError, IndexError, TypeError):
                continue
            content = delta.get("content")
            if content:
                yield content


@dataclass
class EndpointConfig:
    """单个端点的连接参数，与 DeepSeekClient 构造所需字段对齐（鸭子类型）。"""

    api_key: str
    base_url: str
    model: str
    timeout: float
    json_temperature: float


class LLMRouter:
    """按 (provider, depth) 路由到对应端点的客户端缓存。

    provider 取自 SidecarConfig.providers（deepseek / qwen），depth 决定 fast/deep 模型。
    provider 或 depth 未配置（Key 空 / 模型空）时抛 KeyError，由调用方转成清晰错误。
    """

    def __init__(self, config: SidecarConfig) -> None:
        self._config = config
        self._clients: dict[tuple[str, str], DeepSeekClient] = {}

    def get(self, provider: str, depth: str) -> DeepSeekClient:
        key = (provider, depth)
        if key not in self._clients:
            provider_cfg = self._config.providers[provider]
            model = provider_cfg["models"][depth]
            if not model:
                raise KeyError(f"provider {provider} 未配置 {depth} 模型")
            if not provider_cfg.get("api_key") or not provider_cfg.get("base_url"):
                raise KeyError(f"provider {provider} 未配置 API_KEY 或 BASE_URL")
            self._clients[key] = DeepSeekClient(
                EndpointConfig(
                    api_key=provider_cfg["api_key"],
                    base_url=provider_cfg["base_url"],
                    model=model,
                    timeout=self._config.timeout,
                    json_temperature=self._config.json_temperature,
                )
            )
        return self._clients[key]


class FakeLLMClient(LLMClient):
    """离线测试用：按提示词特征词返回对应操作的固定 JSON / 文本，不触发网络请求。"""

    def chat(self, messages: list[Message], *, json_mode: bool = False, temperature: float | None = None) -> str:
        # 多模态消息 content 可能是 parts 数组，content_text 归为纯文本供特征词匹配
        last = content_text(messages[-1]["content"]) if messages else ""
        if not (json_mode or "只输出 JSON" in last):
            return "（FakeLLM）这是离线测试回复。"
        # 各操作使用互斥的指令短语做匹配（仅看提示词前 300 字符指令区）
        head = last[:300]
        if "拆成两部分：约束条件" in head:  # 拆卸用户输入
            return '{"constraints": "要求简洁、使用中文", "intent": "请整理会议记录"}'
        if "拆成两部分：结论 与 支撑" in head:  # 拆卸模型回复
            return '{"conclusion": "核心结论示例", "support": "支撑论据示例"}'
        if "拆成三层" in head:  # 拆卸工具调用
            return '{"call_intent": "为回答查询笔记本相关笔记", "args": {"query": "会议记录"}, "result_summary": "检索到 2 篇相关笔记"}'
        if "关键片段" in head:  # 缩减用户输入（较长文本）
            return '{"intent": "请整理会议记录", "key_fragments": ["会议结论：预算 10 万", "下周复盘"]}'
        if "丢弃中间推理" in head:  # 缩减模型回复
            return '{"conclusion": "核心结论示例", "key_arguments": ["关键论据一", "关键论据二"]}'
        if "跨会话长期保留" in head:  # 长期记忆抽取（extract_memories.md 首句含此短语；extract_anchors.md 不含）
            return '{"memories": [{"text": "用户偏好：要求简洁中文回复", "category": "preference", "importance": 3}]}'
        if "事实锚点" in head:  # 远期事实锚点提取
            return '{"anchors": ["用户偏好：要求简洁中文回复", "已确认事实：项目名 NA"]}'
        return '{"intent": "示例意图", "constraints": "示例约束", "conclusion": "示例结论", "support": "示例支撑"}'

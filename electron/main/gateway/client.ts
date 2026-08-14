import type { SidecarManager } from '../sidecar/manager'
import { parseSseBlock, type ChatStreamEvent } from './sse'

export type { ChatStreamEvent } from './sse'

/** 模型提供商（deepseek 文本 / qwen 视觉），与 renderer 的 ProviderKey 一致 */
export type ProviderKey = 'deepseek' | 'qwen'
/** DS 深度两档（快速/深度），与 renderer 的 DepthKey 一致 */
export type DepthKey = 'fast' | 'deep'

/**
 * Sidecar HTTP 客户端（gateway）：
 * 从 SidecarManager 取 baseUrl + Bearer token，把 /chat 的 SSE 流转发给 renderer。
 * 单 stream 由 conversationId 关联，支持中途停止（AbortController）。
 */
export class GatewayClient {
  private readonly aborters = new Map<string, AbortController>()

  constructor(private readonly sidecar: SidecarManager) {}

  isReady(): boolean {
    return this.sidecar.isReady
  }

  /**
   * 发起一次流式对话。onEvent 逐条收到 sidecar 的 SSE 事件。
   * 停止时调用 abort(conversationId)，本方法以 AbortError 结束。
   */
  async sendChat(
    conversationId: string,
    message: string,
    onEvent: (ev: ChatStreamEvent) => void,
    provider?: ProviderKey,
    depth?: DepthKey,
    attachmentIds?: string[]
  ): Promise<void> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')

    const controller = new AbortController()
    this.aborters.set(conversationId, controller)
    try {
      const res = await fetch(`${endpoint.baseUrl}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${endpoint.token}`
        },
        body: JSON.stringify({
          conversation_id: conversationId,
          message,
          ...(provider ? { provider } : {}),
          ...(depth ? { depth } : {}),
          ...(attachmentIds && attachmentIds.length > 0 ? { attachment_ids: attachmentIds } : {})
        }),
        signal: controller.signal
      })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`sidecar 返回 ${res.status}: ${body}`)
      }
      const reader = res.body?.getReader()
      if (!reader) throw new Error('sidecar 响应无 body')

      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        // SSE 事件以空行分隔，逐条解析
        let sep = buf.indexOf('\n\n')
        while (sep >= 0) {
          const block = buf.slice(0, sep)
          buf = buf.slice(sep + 2)
          const ev = parseSseBlock(block, conversationId)
          if (ev) onEvent(ev)
          sep = buf.indexOf('\n\n')
        }
      }
    } finally {
      this.aborters.delete(conversationId)
    }
  }

  abort(conversationId: string): void {
    this.aborters.get(conversationId)?.abort()
  }

  /**
   * 上传附件（当前仅保存展示）：renderer 传来的 ArrayBuffer → FormData/Blob → POST /attachments。
   */
  async uploadAttachment(payload: {
    conversationId: string
    name: string
    type: string
    data: ArrayBuffer
  }): Promise<unknown> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')
    const form = new FormData()
    form.append('conversation_id', payload.conversationId)
    form.append('file', new Blob([payload.data], { type: payload.type }), payload.name)
    const res = await fetch(`${endpoint.baseUrl}/attachments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}` },
      body: form
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`上传失败 ${res.status}: ${body}`)
    }
    return res.json()
  }

  /** 删除附件：通知 sidecar 移除文件与元数据。 */
  async deleteAttachment(payload: { conversationId: string; id: string }): Promise<{ ok: boolean }> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')
    const res = await fetch(
      `${endpoint.baseUrl}/attachments/${encodeURIComponent(payload.conversationId)}/${encodeURIComponent(payload.id)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${endpoint.token}` } }
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`删除附件失败 ${res.status}: ${body}`)
    }
    return { ok: true }
  }

  /** 列出历史会话（侧边栏「历史对话」面板数据源）。 */
  async listConversations(): Promise<unknown> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')
    const res = await fetch(`${endpoint.baseUrl}/conversations`, {
      headers: { Authorization: `Bearer ${endpoint.token}` }
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`获取会话列表失败 ${res.status}: ${body}`)
    }
    return res.json()
  }

  /** 读取单会话完整历史轮次（恢复渲染消息流）。 */
  async getConversation(conversationId: string): Promise<unknown> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')
    const res = await fetch(
      `${endpoint.baseUrl}/conversations/${encodeURIComponent(conversationId)}`,
      { headers: { Authorization: `Bearer ${endpoint.token}` } }
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`读取会话失败 ${res.status}: ${body}`)
    }
    return res.json()
  }

  /** 删除历史会话（磁盘目录 + 附件一并清理）。 */
  async deleteConversation(conversationId: string): Promise<unknown> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')
    const res = await fetch(
      `${endpoint.baseUrl}/conversations/${encodeURIComponent(conversationId)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${endpoint.token}` } }
    )
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`删除会话失败 ${res.status}: ${body}`)
    }
    return res.json()
  }

  // ---------------- 知识库 RAG ----------------

  /** 通用 JSON POST：endpoint 检查 + Bearer + res.ok 校验，返回解析后的 JSON。 */
  private async postJson(path: string, body: unknown): Promise<unknown> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')
    const res = await fetch(`${endpoint.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.token}`
      },
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`sidecar 返回 ${res.status}: ${errBody}`)
    }
    return res.json()
  }

  /** 索引状态（不触发重建）：docs/chunks/index_type/是否就绪。 */
  async getKnowledgeStatus(): Promise<unknown> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')
    const res = await fetch(`${endpoint.baseUrl}/knowledge/status`, {
      headers: { Authorization: `Bearer ${endpoint.token}` }
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`sidecar 返回 ${res.status}: ${errBody}`)
    }
    return res.json()
  }

  /** 重建/增量更新索引，返回 {docs, chunks, updated, skipped, elapsed}。 */
  async reindexKnowledge(payload?: { incremental?: boolean }): Promise<unknown> {
    return this.postJson('/knowledge/reindex', payload ?? {})
  }

  /** 通用 JSON 请求（POST/DELETE 带 body）：endpoint 检查 + Bearer + res.ok 校验。 */
  private async requestJson(method: 'POST' | 'DELETE', path: string, body?: unknown): Promise<unknown> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')
    const res = await fetch(`${endpoint.baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${endpoint.token}`
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`sidecar 返回 ${res.status}: ${errBody}`)
    }
    return res.json()
  }

  /** 知识库列表（{id, name, created_at, files, chunks, indexed}）。 */
  async listKnowledgeBases(): Promise<unknown> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')
    const res = await fetch(`${endpoint.baseUrl}/knowledge/kbs`, {
      headers: { Authorization: `Bearer ${endpoint.token}` }
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`sidecar 返回 ${res.status}: ${errBody}`)
    }
    return res.json()
  }

  /** 创建知识库（服务端建目录，无需索引）。 */
  async createKnowledgeBase(name: string): Promise<unknown> {
    return this.postJson('/knowledge/kbs', { name })
  }

  /** 删除知识库（含索引目录 + 注册表记录）。 */
  async deleteKnowledgeBase(kbId: string): Promise<unknown> {
    return this.requestJson('DELETE', `/knowledge/kbs/${encodeURIComponent(kbId)}`)
  }

  /** 列出知识库内文件（{rel, name, size, mtime}）。 */
  async listKbFiles(kbId: string): Promise<unknown> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')
    const res = await fetch(`${endpoint.baseUrl}/knowledge/kbs/${encodeURIComponent(kbId)}/files`, {
      headers: { Authorization: `Bearer ${endpoint.token}` }
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`sidecar 返回 ${res.status}: ${errBody}`)
    }
    return res.json()
  }

  /**
   * 上传文件到知识库（multipart，多 file part，filename=相对路径）：
   * 服务端「写文件 + reindex」一体，返回 stats。
   */
  async uploadKbFiles(kbId: string, files: { relPath: string; type: string; data: ArrayBuffer }[]): Promise<unknown> {
    const endpoint = this.sidecar.getEndpoint()
    if (!endpoint) throw new Error('sidecar 未就绪')
    const form = new FormData()
    for (const f of files) {
      form.append('file', new Blob([f.data], { type: f.type }), f.relPath)
    }
    const res = await fetch(`${endpoint.baseUrl}/knowledge/kbs/${encodeURIComponent(kbId)}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${endpoint.token}` },
      body: form
    })
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      throw new Error(`上传失败 ${res.status}: ${errBody}`)
    }
    return res.json()
  }

  /** 删除知识库内文件（服务端「删文件 + reindex」一体）。 */
  async deleteKbFile(kbId: string, rel: string): Promise<unknown> {
    return this.requestJson('DELETE', `/knowledge/kbs/${encodeURIComponent(kbId)}/files`, { rel })
  }

  /** 混合检索：返回按分数降序的 chunk 片段（带 sources 来源）；kb_id 限定单个知识库。 */
  async searchKnowledge(payload: { query: string; kb_id?: string; top_n?: number }): Promise<unknown> {
    return this.postJson('/knowledge/search', payload)
  }

  /** 检索 + LLM 生成：返回 answer + citations + conversation_id（该轮落盘历史会话）；
   *  kb_id 限定单个知识库。 */
  async queryKnowledge(payload: {
    query: string
    kb_id?: string
    provider?: ProviderKey
    depth?: DepthKey
    top_n?: number
    conversation_id?: string
  }): Promise<unknown> {
    return this.postJson('/knowledge/query', payload)
  }
}

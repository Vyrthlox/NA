import { useCallback, useEffect, useRef, useState } from 'react'
import { markdownToTiptapHtml } from './markdown-to-tiptap'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
  error?: boolean
  /** 知识库问答消息携带的引用来源（assistant 气泡下渲染 chips） */
  citations?: KnowledgeCitation[]
}

/** 「基于知识库」开关状态：enabled=开 + kbId=所选知识库 */
export interface KbSend {
  enabled: boolean
  kbId?: string
}

/** @organize 文档整理落盘结果（保存成功后输入区显示反馈条） */
export interface OrganizeResult {
  ok: boolean
  relPath: string
  error?: string
}

/** @organize <相对路径> 命令：路径为应用内文件库相对路径（可含空格） */
const ORGANIZE_RE = /^@organize\s+(.+)$/

/** 剥离模型常见的整段 ```markdown ... ``` 围栏，只留文档正文 */
function stripDocFence(content: string): string {
  const m = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/s.exec(content.trim())
  return m ? m[1].trim() + '\n' : content
}

export interface UseChat {
  /** sidecar 引擎状态（starting/ready/...），ready 前发送被禁用 */
  sidecarStatus: SidecarStatus
  messages: ChatMessage[]
  streaming: boolean
  /** 当前会话 id（null=尚未开始；点击历史会话后为该会话 id，用于面板高亮） */
  conversationId: string | null
  /** 本会话已上传附件（仅保存展示，暂不注入 AI 上下文） */
  attachments: Attachment[]
  /** 上传失败时的错误提示（空串/正常时 null） */
  uploadError: string | null
  /** @organize 文档整理落盘结果（null=无）；ok=false 时 error 为失败原因 */
  organizeResult: OrganizeResult | null
  /** 清除 organizeResult（关闭输入区的保存反馈条） */
  clearOrganizeResult: () => void
  /** 发送消息：模型选择（provider 提供商 × depth 档位），未传则默认 deepseek·fast；kb 开启「基于知识库」时走纯知识库问答 */
  send: (text: string, choice?: ModelChoice, kb?: KbSend) => void
  stop: () => void
  /** 上传文件：读为 ArrayBuffer → IPC → sidecar 落盘，成功后加入附件列表 */
  upload: (file: File) => Promise<void>
  /** 移除附件：本地先删，并通知 sidecar 清理文件 */
  removeAttachment: (id: string) => void
  /** 载入历史会话：拉取该会话历史轮次渲染到主区，之后发送继续该会话 */
  loadConversation: (conversationId: string) => Promise<void>
  /** 新建对话：清空主区与附件，下一次发送生成新会话 */
  startNewConversation: () => void
}

/**
 * 聊天会话状态：持有单对话 conversationId，订阅 sidecar 状态与流式事件，
 * 把 chunk 逐字追加到最后一条 assistant 消息。
 */
export function useChat(): UseChat {
  const [sidecarStatus, setSidecarStatus] = useState<SidecarStatus>('starting')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [streaming, setStreaming] = useState(false)
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [uploadError, setUploadError] = useState<string | null>(null)
  const [organizeResult, setOrganizeResult] = useState<OrganizeResult | null>(null)
  const conversationIdRef = useRef<string | null>(null)
  const streamingRef = useRef(false)
  /** 当前待落盘的 @organize 目标（done 事件带 reply 时写文件），随发送/结束清空 */
  const organizePendingRef = useRef<{ conversationId: string; relPath: string } | null>(null)

  // 订阅 sidecar 引擎状态
  useEffect(() => {
    void window.api.sidecar.getStatus().then((info) => setSidecarStatus(info.status))
    return window.api.sidecar.onStatusChange(setSidecarStatus)
  }, [])

  // 订阅流式事件（单对话：只处理当前 conversationId 的事件）
  useEffect(() => {
    return window.api.chat.onEvent((ev) => {
      if (conversationIdRef.current && ev.conversationId !== conversationIdRef.current) return
      if (ev.type === 'chunk') {
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          if (last && last.role === 'assistant' && !last.error) {
            return [...prev.slice(0, -1), { ...last, content: last.content + ev.data.content }]
          }
          return [...prev, { role: 'assistant', content: ev.data.content }]
        })
      } else if (ev.type === 'done') {
        streamingRef.current = false
        setStreaming(false)
        // @organize 收尾：done 携带完整 reply，转成 TipTap 富文本 HTML 写入目标文件（创建或覆盖）
        const pending = organizePendingRef.current
        if (pending && pending.conversationId === ev.conversationId) {
          organizePendingRef.current = null
          const reply = (ev.data as { reply?: string }).reply ?? ''
          const relPath = pending.relPath
          const body = stripDocFence(reply)
          void (async () => {
            const content = await markdownToTiptapHtml(body)
            await window.api.library.writeOrganize({ relPath, content })
          })()
            .then(() => {
              // 通知文件库面板刷新，让新文档立刻出现
              window.dispatchEvent(new Event('library:changed'))
              setOrganizeResult({ ok: true, relPath })
            })
            .catch((err: unknown) => {
              setOrganizeResult({
                ok: false,
                relPath,
                error: err instanceof Error ? err.message : String(err)
              })
            })
        }
      } else if (ev.type === 'error') {
        streamingRef.current = false
        setStreaming(false)
        // 流中途失败：清掉待落盘目标，并把失败反馈给输入区
        if (organizePendingRef.current) {
          const pending = organizePendingRef.current
          organizePendingRef.current = null
          setOrganizeResult({ ok: false, relPath: pending.relPath, error: ev.data.error })
        }
        setMessages((prev) => {
          const last = prev[prev.length - 1]
          const errText = `[错误] ${ev.data.error}`
          if (last && last.role === 'assistant' && !last.error) {
            return [...prev.slice(0, -1), { ...last, content: last.content + `\n${errText}`, error: true }]
          }
          return [...prev, { role: 'assistant', content: errText, error: true }]
        })
      }
    })
  }, [])

  const send = useCallback(
    (text: string, choice?: ModelChoice, kb?: KbSend): void => {
      const message = text.trim()
      if (!message || streamingRef.current || sidecarStatus !== 'ready') return
      if (!conversationIdRef.current) {
        conversationIdRef.current = crypto.randomUUID()
        setConversationId(conversationIdRef.current)
      }
      const conversationId = conversationIdRef.current
      // @organize <路径>：应用内命令，把模型回复保存到目标文件；KB 开关不参与
      const organizeMatch = ORGANIZE_RE.exec(message)
      const organizeTarget = organizeMatch ? organizeMatch[1].trim() : null
      organizePendingRef.current = organizeTarget ? { conversationId, relPath: organizeTarget } : null
      const useKb = !organizeTarget && !!kb?.enabled && !!kb?.kbId
      // 本消息附带的附件 id（sidecar 读取文件内容注入上下文；@organize 时随命令一起整理）
      const attachmentIds = attachments.map((a) => a.id)
      streamingRef.current = true
      setStreaming(true)
      setMessages((prev) => [...prev, { role: 'user', content: message }])

      // 纯知识库问答：/knowledge/query 单次返回 answer + citations，不掺普通聊天上下文；
      // 该轮问答由 sidecar 落盘到本会话（历史对话可见）
      if (useKb) {
        void window.api.knowledge
          .query({
            query: message,
            kb_id: kb.kbId,
            provider: choice?.provider ?? 'deepseek',
            depth: choice?.depth ?? 'fast',
            conversation_id: conversationId
          })
          .then((res) => {
            // 服务端可能新建会话 → 采纳回传的 conversation_id，保证历史列表与主区一致
            if (res?.conversation_id && res.conversation_id !== conversationIdRef.current) {
              conversationIdRef.current = res.conversation_id
              setConversationId(res.conversation_id)
            }
            setMessages((prev) => [
              ...prev,
              { role: 'assistant', content: res.answer ?? '', citations: res.citations ?? [] }
            ])
          })
          .catch((err: unknown) => {
            setMessages((prev) => [
              ...prev,
              { role: 'assistant', content: `[错误] ${String(err)}`, error: true }
            ])
          })
          .finally(() => {
            streamingRef.current = false
            setStreaming(false)
          })
        return
      }

      // 普通对话：SSE 流式
      void window.api.chat
        .send({
          message,
          conversationId,
          provider: choice?.provider ?? 'deepseek',
          depth: choice?.depth ?? 'fast',
          attachment_ids: attachmentIds
        })
        .then(() => {
          // 主进程已接收该消息 → 附件随消息发出，清空输入区附件（每消息语义）
          if (attachmentIds.length > 0) setAttachments([])
        })
        .catch((err: unknown) => {
          streamingRef.current = false
          setStreaming(false)
          // 发起即失败：不会再有 done，清掉待落盘目标，避免污染下一次 done
          if (organizePendingRef.current) {
            organizePendingRef.current = null
          }
          setMessages((prev) => [
            ...prev,
            { role: 'assistant', content: `[错误] ${String(err)}`, error: true }
          ])
        })
    },
    [sidecarStatus, attachments]
  )

  const stop = useCallback((): void => {
    streamingRef.current = false
    setStreaming(false)
    // 主动停止：不会有 done，清掉待落盘目标
    organizePendingRef.current = null
    const conversationId = conversationIdRef.current
    if (conversationId) void window.api.chat.stop(conversationId)
  }, [])

  const clearOrganizeResult = useCallback((): void => {
    setOrganizeResult(null)
  }, [])

  const upload = useCallback(async (file: File): Promise<void> => {
    try {
      if (!conversationIdRef.current) conversationIdRef.current = crypto.randomUUID()
      const conversationId = conversationIdRef.current
      const data = await file.arrayBuffer()
      const attachment = await window.api.chat.upload({
        conversationId,
        name: file.name,
        type: file.type,
        size: file.size,
        data
      })
      setUploadError(null)
      setAttachments((prev) => [...prev, attachment])
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const removeAttachment = useCallback((id: string): void => {
    // 本地先移除，界面即时反馈；通知 sidecar 清理失败不打扰用户
    setAttachments((prev) => prev.filter((a) => a.id !== id))
    const conversationId = conversationIdRef.current
    if (conversationId) {
      void window.api.chat.deleteAttachment({ conversationId, id }).catch(() => {})
    }
  }, [])

  const loadConversation = useCallback(async (id: string): Promise<void> => {
    conversationIdRef.current = id
    setConversationId(id)
    setStreaming(false)
    streamingRef.current = false
    organizePendingRef.current = null
    setOrganizeResult(null)
    setAttachments([])
    try {
      const data = await window.api.conversations.get(id)
      const turns = data?.turns ?? []
      const loaded = turns
        .filter((t) => t && typeof t.text === 'string' && t.text.length > 0)
        .map((t): ChatMessage => {
          const msg: ChatMessage = { role: t.role, content: t.text }
          // 知识库问答轮次恢复引用来源 chips
          if (t.citations && t.citations.length > 0) msg.citations = t.citations
          return msg
        })
      setMessages(loaded)
    } catch (err) {
      // 拉取失败不打断：会话 id 已指向该会话，可直接继续发消息
      setMessages([])
      console.warn(`加载会话 ${id} 失败：`, err)
    }
  }, [])

  const startNewConversation = useCallback((): void => {
    conversationIdRef.current = null
    setConversationId(null)
    setStreaming(false)
    streamingRef.current = false
    organizePendingRef.current = null
    setOrganizeResult(null)
    setMessages([])
    setAttachments([])
  }, [])

  return {
    sidecarStatus,
    messages,
    streaming,
    conversationId,
    attachments,
    uploadError,
    organizeResult,
    clearOrganizeResult,
    send,
    stop,
    upload,
    removeAttachment,
    loadConversation,
    startNewConversation
  }
}

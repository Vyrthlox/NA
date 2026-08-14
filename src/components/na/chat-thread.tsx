import { useEffect, useRef } from 'react'
import { cn } from '../../lib/cn'
import type { ChatMessage } from '../../lib/use-chat'
import { CitationChips } from '../knowledge/citation-chips'
import { ThinkingIndicator } from './thinking-indicator'

interface ChatThreadProps {
  messages: ChatMessage[]
  streaming: boolean
}

/** 对话消息流：用户右侧绿色气泡，assistant 左侧白底气泡；流式时末尾显示光标 */
export function ChatThread({ messages, streaming }: ChatThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const lastIndex = messages.length - 1
  const lastStreaming =
    streaming && messages[lastIndex]?.role === 'assistant' && !messages[lastIndex].error
  // 已发出提问但首个回复块尚未到达：末尾是用户消息，此时显示「思考中」立方体
  const waitingFirstChunk = streaming && messages[lastIndex]?.role === 'user'

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-8 py-6">
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        {messages.map((m, i) => (
          <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-6',
                m.role === 'user'
                  ? 'bg-green-500 text-white'
                  : 'border border-gray-200/80 bg-white text-gray-800',
                m.error && 'border-red-200 text-red-600'
              )}
            >
              <div className="whitespace-pre-wrap break-words">{m.content}</div>
              {/* 知识库问答引用来源 chips */}
              {m.role === 'assistant' && m.citations && m.citations.length > 0 && (
                <CitationChips citations={m.citations} />
              )}
              {/* 流式生成中的光标 */}
              {lastStreaming && i === lastIndex && (
                <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-green-500 align-middle" />
              )}
            </div>
          </div>
        ))}
        {/* AI 首个回复块到达前显示思考中动画 */}
        {waitingFirstChunk && <ThinkingIndicator />}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

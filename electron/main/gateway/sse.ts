/** 与 sidecar /chat 的 SSE 事件一一对应（meta/chunk/done/error） */
export type ChatStreamEvent =
  | { conversationId: string; type: 'meta'; data: { conversation_id: string; n: number; m: number } }
  | { conversationId: string; type: 'chunk'; data: { content: string } }
  | {
      conversationId: string
      type: 'done'
      data: {
        conversation_id: string
        reply: string
        tier_counts: Record<string, number>
        context_path: string
        dismantled_path: string
      }
    }
  | { conversationId: string; type: 'error'; data: { error: string } }

/**
 * 解析单个 SSE 块（event: X\ndata: {json}），非本协议事件返回 null。
 * 纯函数、无运行时依赖，可被 Node 直接加载测试。
 */
export function parseSseBlock(block: string, conversationId: string): ChatStreamEvent | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of block.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return null
  let data: unknown
  try {
    data = JSON.parse(dataLines.join('\n'))
  } catch {
    return null
  }
  if (event !== 'meta' && event !== 'chunk' && event !== 'done' && event !== 'error') return null
  return { conversationId, type: event, data } as ChatStreamEvent
}

import { useCallback, useEffect, useState } from 'react'
import { ChevronLeft, ChevronRight, History, Plus, Trash2 } from 'lucide-react'
import { cn } from '../../lib/cn'

/** 右键菜单状态：null=关闭；id=目标会话，x/y=菜单左上角坐标 */
interface ContextMenuState {
  id: string
  x: number
  y: number
}

/** 待删除确认的会话（浮层确认，替代不可靠的 window.confirm） */
interface ConfirmingState {
  id: string
  title: string
}

interface RecentConversationsProps {
  /** 当前会话 id（高亮用） */
  currentId: string | null
  /** 点击历史会话：载入该会话历史并继续 */
  onSelect: (conversationId: string) => void
  /** 新建对话 */
  onNew: () => void
}

/** 把 ISO 时间格式化为 `MM-DD HH:mm`；无效返回空串 */
function formatTime(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** NA 页右侧「历史对话」面板：可折叠；展示历史会话列表，点击载入并继续对话 */
export function RecentConversations({ currentId, onSelect, onNew }: RecentConversationsProps) {
  const [collapsed, setCollapsed] = useState(false)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [confirming, setConfirming] = useState<ConfirmingState | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const refresh = useCallback((): void => {
    window.api.conversations
      .list()
      .then((data) => setConversations(data?.conversations ?? []))
      .catch((err: unknown) => {
        console.warn('加载历史对话失败：', err)
        setConversations([])
      })
  }, [])

  // 关闭右键菜单：点击任意处 / 再次右键 / Escape / 滚动
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenu(null)
    }
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [menu])

  // 关闭确认浮层：Escape / 点遮罩
  useEffect(() => {
    if (!confirming) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setConfirming(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [confirming])

  // 菜单「删除该对话」→ 关闭菜单，弹出确认浮层
  const requestDelete = useCallback(
    (id: string): void => {
      const target = conversations.find((c) => c.conversation_id === id)
      setMenu(null)
      setConfirming({ id, title: target?.title || id })
    },
    [conversations]
  )

  // 确认浮层「删除」→ 真正执行删除
  const confirmDelete = useCallback((): void => {
    if (!confirming) return
    const { id } = confirming
    setConfirming(null)
    setDeleteError(null)
    window.api.conversations
      .delete(id)
      .then(() => {
        // 删除的是当前打开的会话 → 主区清空回新建态
        if (id === currentId) onNew()
        refresh()
      })
      .catch((err: unknown) => {
        console.warn('删除会话失败：', err)
        setDeleteError(`删除失败：${err instanceof Error ? err.message : String(err)}`)
      })
  }, [confirming, currentId, onNew, refresh])

  // 挂载时加载；sidecar 就绪时刷新（首次 list 可能早于 ready 而失败，须在 ready 后重试）；
  // 每次对话完成/出错后刷新（新会话落盘后即时出现）
  useEffect(() => {
    refresh()
    const offStatus = window.api.sidecar.onStatusChange((status) => {
      if (status === 'ready') refresh()
    })
    const offEvent = window.api.chat.onEvent((ev) => {
      if (ev.type === 'done' || ev.type === 'error') refresh()
    })
    return () => {
      offStatus()
      offEvent()
    }
  }, [refresh])

  return (
    <div className="flex h-full shrink-0">
      {/* 折叠开关：常驻于面板左缘（折叠后位于内容区右边缘） */}
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        title={collapsed ? '展开历史对话' : '收起历史对话'}
        className="z-10 flex h-20 w-5 shrink-0 items-center justify-center self-center rounded-l-md border border-r-0 border-gray-200/70 bg-white text-gray-400 shadow-sm transition-colors hover:bg-gray-50 hover:text-gray-600"
      >
        {collapsed ? <ChevronLeft className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
      </button>

      {/* 面板本体：宽度 288px ⇄ 0，实现向右边框折叠 */}
      <div
        className={cn(
          'overflow-hidden border-l border-gray-200/70 bg-white transition-[width] duration-300 ease-in-out',
          collapsed ? 'w-0' : 'w-72'
        )}
      >
        <div className="flex h-full w-72 flex-col">
          {/* 顶部标题 + 新建对话按钮 */}
          <div className="flex items-center justify-between px-4 pt-4">
            <span className="text-xs font-medium text-gray-400">历史对话</span>
            <button
              type="button"
              onClick={onNew}
              title="新建对话"
              className="flex h-9 items-center rounded-lg px-2.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-800"
            >
              <Plus className="h-3.5 w-3.5 text-gray-400" />
            </button>
          </div>

          {/* 删除失败错误条 */}
          {deleteError && (
            <div className="mx-3 mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-1.5 text-xs text-red-600">
              {deleteError}
            </div>
          )}

          {/* 会话列表 / 空态 */}
          {conversations.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-4 text-xs text-gray-400">
              暂无对话
            </div>
          ) : (
            <div className="mt-1 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
              {conversations.map((c) => {
                const active = c.conversation_id === currentId
                const time = formatTime(c.updated_at)
                return (
                  <button
                    key={c.conversation_id}
                    type="button"
                    onClick={() => onSelect(c.conversation_id)}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      // stopPropagation：避免事件继续冒泡到 window 的 contextmenu 关闭监听器
                      //（否则菜单已打开时再次右键会话会"开→立即关"，表现为右键无反应）
                      e.stopPropagation()
                      // 菜单宽 ~140px、高 ~90px，clamp 避免溢出视口
                      setMenu({
                        id: c.conversation_id,
                        x: Math.min(e.clientX, window.innerWidth - 148),
                        y: Math.min(e.clientY, window.innerHeight - 96)
                      })
                    }}
                    title={c.preview || c.title}
                    className={cn(
                      'flex w-full flex-col gap-1 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-gray-50',
                      active && 'bg-gray-100 hover:bg-gray-100'
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <History
                        className={cn('h-3.5 w-3.5 shrink-0', active ? 'text-green-600' : 'text-gray-400')}
                      />
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-sm font-medium',
                          active ? 'text-gray-900' : 'text-gray-700'
                        )}
                      >
                        {c.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 pl-6 text-xs text-gray-400">
                      <span>{c.turn_count} 轮</span>
                      {time && <span>·</span>}
                      {time && <span>{time}</span>}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* 右键菜单：删除当前会话 */}
      {menu && (
        <div
          className="fixed z-50 w-36 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            onClick={() => requestDelete(menu.id)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-red-600 transition-colors hover:bg-red-50"
          >
            <Trash2 className="h-3.5 w-3.5" />
            删除该对话
          </button>
        </div>
      )}

      {/* 删除确认浮层（自绘，替代 window.confirm） */}
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
          onClick={() => setConfirming(null)}
        >
          <div
            className="w-80 rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-medium text-gray-800">删除该历史对话？</div>
            <div className="mt-2 text-xs leading-5 text-gray-500">
              「{confirming.title}」将连同其附件一并删除，此操作不可恢复。
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirming(null)}
                className="h-9 rounded-lg px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={confirmDelete}
                className="h-9 rounded-lg bg-red-500 px-3 text-xs font-medium text-white transition-colors hover:bg-red-600"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

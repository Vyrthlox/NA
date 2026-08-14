import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import {
  ChevronDown,
  Database,
  FileText,
  Image,
  Languages,
  MoreHorizontal,
  PenLine,
  Plus,
  RefreshCw,
  SendHorizontal,
  Square,
  X,
  type LucideIcon
} from 'lucide-react'
import { ModelSelector, type ModelChoice } from './model-selector'
import { cn } from '../../lib/cn'

/** 底部快捷能力按钮配置（收进【更多】下拉，后续接入 sidecar 对应能力） */
const QUICK_ACTIONS: { key: string; label: string; icon: LucideIcon }[] = [
  { key: 'write', label: '帮我写作', icon: PenLine },
  { key: 'translate', label: '内容翻译', icon: Languages },
  { key: 'summarize', label: '文档总结', icon: FileText },
  { key: 'image', label: '图片生成', icon: Image }
]

/** 附件类型白名单（与 sidecar 端一致）与体积上限（100MB） */
const ALLOWED_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'txt', 'md', 'html', 'png', 'jpg', 'jpeg'])
const MAX_FILE_SIZE = 100 * 1024 * 1024

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`
  return `${bytes}B`
}

function isImage(name: string): boolean {
  return /\.(png|jpe?g)$/i.test(name)
}

/** 「基于知识库」开关状态（与 use-chat 的 KbSend 一致） */
export interface KbSend {
  enabled: boolean
  kbId?: string
}

interface ChatInputProps {
  onSend: (text: string, choice: ModelChoice, kb?: KbSend) => void
  onStop?: () => void
  sending?: boolean
  status?: SidecarStatus
  attachments?: Attachment[]
  onUpload?: (file: File) => void
  onRemoveAttachment?: (id: string) => void
  uploadError?: string | null
}

/**
 * AI 对话输入框：大尺寸多行输入区，底部工具栏。
 * 左组：模型选择 + 上传 + 「基于知识库」开关（开启后显示知识库选择下拉）；
 * 右组：发送/停止（「基于知识库」开启时隐藏【更多】，否则收【帮我写作】等）。
 */
export function ChatInput({
  onSend,
  onStop,
  sending = false,
  status = 'starting',
  attachments = [],
  onUpload = () => {},
  onRemoveAttachment = () => {},
  uploadError = null
}: ChatInputProps) {
  const [text, setText] = useState('')
  const [choice, setChoice] = useState<ModelChoice>({ provider: 'deepseek', depth: 'fast' })
  const [localError, setLocalError] = useState<string | null>(null)
  const [kbEnabled, setKbEnabled] = useState(false)
  const [kbList, setKbList] = useState<KnowledgeBase[]>([])
  const [kbLoading, setKbLoading] = useState(false)
  const [kbId, setKbId] = useState<string | null>(null)
  const [showKbMenu, setShowKbMenu] = useState(false)
  const [showMore, setShowMore] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const ready = status === 'ready'
  const kbReady = !kbEnabled || !!kbId
  const canSend = text.trim().length > 0 && ready && !sending && kbReady

  const loadKbs = useCallback((): void => {
    setKbLoading(true)
    window.api.knowledge
      .kbs()
      .then((res) => {
        setKbList(res.kbs ?? [])
        // 选中项被删则重置选择
        setKbId((cur) => (cur && (res.kbs ?? []).some((k) => k.id === cur) ? cur : null))
      })
      .catch((err: unknown) => {
        console.warn('获取知识库列表失败：', err)
        setKbList([])
      })
      .finally(() => setKbLoading(false))
  }, [])

  // 打开「基于知识库」开关时拉一次知识库列表
  useEffect(() => {
    if (kbEnabled) loadKbs()
  }, [kbEnabled, loadKbs])

  // 每次打开下拉时重新拉取：开关开启期间在知识库页新建/删除的库立即可见
  useEffect(() => {
    if (showKbMenu && kbEnabled) loadKbs()
  }, [showKbMenu, kbEnabled, loadKbs])

  // 关闭下拉浮层：点击任意处 / Escape / 滚动
  useEffect(() => {
    if (!showKbMenu && !showMore) return
    const close = (): void => {
      setShowKbMenu(false)
      setShowMore(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('click', close)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', close, true)
    }
  }, [showKbMenu, showMore])

  const handleSend = (): void => {
    if (!canSend) return
    onSend(text, choice, { enabled: kbEnabled, kbId: kbId ?? undefined })
    setText('')
  }

  // 快捷能力按钮：当前为前端占位，点击暂无行为
  const handleQuickAction = (_key: string): void => {
    // TODO: 接入 sidecar 对应能力（写作/翻译/总结/图片生成）
  }

  // 上传文件：白名单扩展名 + ≤100MB 校验，合法则交 useChat.upload 上传并落盘
  const handleFileChange = (e: ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files
    if (files && files.length > 0) {
      for (const file of Array.from(files)) {
        const dot = file.name.lastIndexOf('.')
        const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : ''
        if (!ALLOWED_EXTENSIONS.has(ext) || file.size > MAX_FILE_SIZE) {
          setLocalError(`「${file.name}」格式不支持或超过 100MB`)
          continue
        }
        setLocalError(null)
        onUpload(file)
      }
    }
    e.target.value = '' // 允许重复选择同一文件
  }

  // 回车发送；中文输入法组词过程中不触发；流式生成中不重复发送
  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !sending) {
      e.preventDefault()
      handleSend()
    }
  }

  const selectedKbName = kbList.find((k) => k.id === kbId)?.name
  const placeholder = sending
    ? '正在生成…'
    : !ready
      ? 'AI 引擎启动中…'
      : kbEnabled
        ? '基于知识库提问，回答将标注引用…'
        : '向 NA 提问…'

  return (
    <div className="w-[62%] max-w-2xl min-w-[340px]">
      <div className="flex flex-col rounded-2xl border border-gray-200/80 bg-white p-3 shadow-sm focus-within:border-green-200 focus-within:ring-2 focus-within:ring-green-100/70">
        {/* 已上传附件芯片区（仅保存展示） */}
        {attachments.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-1.5">
            {attachments.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-1.5 rounded-lg border border-gray-100 bg-gray-50 py-1 pl-2 pr-1 text-xs text-gray-600"
              >
                {isImage(a.name) ? (
                  <Image className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                ) : (
                  <FileText className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                )}
                <span className="max-w-40 truncate" title={a.name}>
                  {a.name}
                </span>
                <span className="text-gray-400">{formatSize(a.size)}</span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachment(a.id)}
                  title="移除附件"
                  className="rounded p-0.5 text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        {(localError || uploadError) && (
          <p className="mb-2 text-xs text-red-500">{localError || uploadError}</p>
        )}
        {kbEnabled && !kbId && (
          <p className="mb-2 text-xs text-amber-600">已开启「基于知识库」，请选择要检索的知识库</p>
        )}

        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          rows={1}
          placeholder={placeholder}
          className="max-h-64 min-h-[100px] flex-1 resize-none bg-transparent px-1 py-1 text-sm leading-6 text-gray-800 outline-none placeholder:text-gray-400"
        />

        {/* 下边框工具栏 */}
        <div className="flex flex-wrap items-center justify-between gap-1 border-t border-gray-100 pt-2">
          {/* 左组：模型选择 + 上传 + 基于知识库开关 (+ 知识库下拉) */}
          <div className="flex flex-wrap items-center gap-1">
            <ModelSelector value={choice} onChange={setChoice} hasImages={attachments.some((a) => isImage(a.name))} />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="上传本地文件（PDF/DOCX/XLSX/TXT/MD/HTML/PNG/JPG，≤100MB）"
              className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-500 transition-colors hover:bg-gray-50 hover:text-gray-700"
            >
              <Plus className="h-[18px] w-[18px]" />
            </button>

            {/* 「基于知识库」开关 */}
            <button
              type="button"
              onClick={() => setKbEnabled((v) => !v)}
              title="基于知识库提问（纯知识库问答，回答带引用标注）"
              className={cn(
                'flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors',
                kbEnabled
                  ? 'bg-green-50 text-green-700'
                  : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700'
              )}
            >
              <span
                className={cn(
                  'relative h-4 w-7 rounded-full transition-colors',
                  kbEnabled ? 'bg-green-500' : 'bg-gray-300'
                )}
              >
                <span
                  className={cn(
                    'absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all',
                    kbEnabled ? 'left-3.5' : 'left-0.5'
                  )}
                />
              </span>
              基于知识库
            </button>

            {/* 知识库选择下拉（开关开启时显示） */}
            {kbEnabled && (
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    // stopPropagation：窗口外点关闭监听挂在 click 上，React 离散事件同步 flush 会让
                    // 同一次打开的点击立刻触发 close 把菜单关掉（真机鼠标必现）→ 阻止冒泡到 window
                    e.stopPropagation()
                    setShowKbMenu((s) => !s)
                  }}
                  title="选择要检索的知识库"
                  disabled={kbLoading}
                  className={cn(
                    'flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors',
                    kbId
                      ? 'bg-green-50 text-green-700'
                      : 'text-gray-500 hover:bg-gray-50 hover:text-gray-700',
                    kbLoading && 'cursor-not-allowed text-gray-300'
                  )}
                >
                  <Database className="h-3.5 w-3.5 text-gray-400" />
                  <span className="max-w-24 truncate">{kbId ? selectedKbName : '选择知识库'}</span>
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
                {showKbMenu && (
                  <div className="absolute bottom-10 left-0 z-20 w-44 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                    {kbLoading ? (
                      <div className="px-3 py-2 text-xs text-gray-400">加载中…</div>
                    ) : kbList.length === 0 ? (
                      <div className="px-3 py-2 text-xs text-gray-400">暂无知识库，请先创建</div>
                    ) : (
                      kbList.map((k) => (
                        <button
                          key={k.id}
                          type="button"
                          onClick={() => {
                            setKbId(k.id)
                            setShowKbMenu(false)
                          }}
                          className={cn(
                            'flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50',
                            k.id === kbId && 'bg-green-50 text-green-700'
                          )}
                        >
                          <Database className="h-3.5 w-3.5 shrink-0 text-gray-400" />
                          <span className="min-w-0 flex-1 truncate">{k.name}</span>
                        </button>
                      ))
                    )}
                    <div className="border-t border-gray-100">
                      <button
                        type="button"
                        onClick={(e) => {
                          // stopPropagation：避免 window click 监听把菜单关掉，刷新结果留在菜单内可见
                          e.stopPropagation()
                          loadKbs()
                        }}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-500 transition-colors hover:bg-gray-50"
                      >
                        <RefreshCw className={cn('h-3.5 w-3.5 text-gray-400', kbLoading && 'animate-spin')} />
                        刷新列表
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 右组：更多（开关关闭时显示）+ 发送/停止 */}
          <div className="flex items-center gap-1">
            {!kbEnabled && (
              <div className="relative">
                <button
                  type="button"
                  onClick={(e) => {
                    // 同「选择知识库」：阻止打开用的这次点击冒泡到 window 被外点关闭监听立即关掉
                    e.stopPropagation()
                    setShowMore((s) => !s)
                  }}
                  title="更多功能"
                  className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-800"
                >
                  <MoreHorizontal className="h-3.5 w-3.5 text-gray-400" />
                  更多
                </button>
                {showMore && (
                  <div className="absolute bottom-10 right-0 z-20 w-36 overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
                    {QUICK_ACTIONS.map(({ key, label, icon: Icon }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setShowMore(false)
                          handleQuickAction(key)
                        }}
                        disabled={!ready}
                        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:text-gray-300"
                      >
                        <Icon className="h-3.5 w-3.5 text-gray-400" />
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              type="button"
              onClick={sending ? onStop : handleSend}
              disabled={!sending && !canSend}
              title={sending ? '停止生成' : kbEnabled && !kbId ? '请先选择知识库' : '发送'}
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-lg transition-colors',
                sending
                  ? 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                  : canSend
                    ? 'bg-green-500 text-white hover:bg-green-600'
                    : 'cursor-not-allowed bg-gray-100 text-gray-400'
              )}
            >
              {sending ? <Square className="h-4 w-4" /> : <SendHorizontal className="h-[18px] w-[18px]" />}
            </button>
          </div>
        </div>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        accept=".pdf,.docx,.xlsx,.txt,.md,.html,.png,.jpg,.jpeg"
        multiple
        onChange={handleFileChange}
      />
    </div>
  )
}

import { useRef, useState, type ChangeEvent, type KeyboardEvent } from 'react'
import {
  FileText,
  Image,
  Languages,
  PenLine,
  Plus,
  SendHorizontal,
  Square,
  X,
  type LucideIcon
} from 'lucide-react'
import { ModelSelector, type ModelChoice } from './model-selector'
import { cn } from '../../lib/cn'

/** 底部快捷能力按钮配置（后续接入 sidecar 对应能力） */
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

interface ChatInputProps {
  onSend: (text: string, choice: ModelChoice) => void
  onStop?: () => void
  sending?: boolean
  status?: SidecarStatus
  attachments?: Attachment[]
  onUpload?: (file: File) => void
  onRemoveAttachment?: (id: string) => void
  uploadError?: string | null
}

/** AI 对话输入框：大尺寸多行输入区，底部工具栏（左模型选择+上传+快捷能力，右发送/停止） */
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
  const fileInputRef = useRef<HTMLInputElement>(null)
  const ready = status === 'ready'
  const canSend = text.trim().length > 0 && ready && !sending

  const handleSend = (): void => {
    if (!canSend) return
    onSend(text, choice)
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
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && !sending) {
      e.preventDefault()
      handleSend()
    }
  }

  const placeholder = sending ? '正在生成…' : !ready ? 'AI 引擎启动中…' : '向 NA 提问…'

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

            {/* 分隔线：区分基础功能与快捷能力 */}
            <div className="mx-1 h-5 w-px bg-gray-200" />

            {QUICK_ACTIONS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                title={label}
                onClick={() => handleQuickAction(key)}
                disabled={!ready}
                className={cn(
                  'flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium transition-colors',
                  ready
                    ? 'text-gray-600 hover:bg-gray-50 hover:text-gray-800'
                    : 'cursor-not-allowed text-gray-300'
                )}
              >
                <Icon className="h-3.5 w-3.5 text-gray-400" />
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={sending ? onStop : handleSend}
            disabled={!sending && !canSend}
            title={sending ? '停止生成' : '发送'}
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

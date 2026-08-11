import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  EditorContent,
  useEditor,
  useEditorState,
  type Editor
} from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { TextStyle } from '@tiptap/extension-text-style'
import Color from '@tiptap/extension-color'
import Highlight from '@tiptap/extension-highlight'
import {
  Bold,
  ChevronDown,
  Code2,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  Italic,
  List,
  ListOrdered,
  Minus,
  Palette,
  Quote,
  Redo2,
  RemoveFormatting,
  Strikethrough,
  Type,
  Underline,
  Undo2,
  X
} from 'lucide-react'
import { cn } from '../../lib/cn'
import { displayFileName } from '../../lib/library-name'

/** 保存状态：已保存 / 保存中… / 保存失败 */
type SaveState = 'saved' | 'saving' | 'error'

const HEADING_OPTIONS = [
  { label: '正文', level: 0 },
  { label: '标题 1', level: 1 },
  { label: '标题 2', level: 2 },
  { label: '标题 3', level: 3 }
]

/** 预设文字色：默认（清除颜色）+ 常用色 */
const COLOR_PRESETS: Array<{ label: string; color: string | undefined }> = [
  { label: '默认', color: undefined },
  { label: '黑', color: '#1f2937' },
  { label: '灰', color: '#6b7280' },
  { label: '红', color: '#ef4444' },
  { label: '橙', color: '#f97316' },
  { label: '绿', color: '#22c55e' },
  { label: '蓝', color: '#3b82f6' },
  { label: '紫', color: '#8b5cf6' }
]

interface NoteEditorProps {
  node: LibraryNode
  onClose: () => void
}

/** 遗留 .md 纯文本转义，保证进编辑器后按文本显示、不解析 HTML */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** 自绘浮层：相对 trigger 容器定位，点外部 / Escape 关闭（复用右键菜单的交互模式） */
function Popover({
  open,
  onClose,
  children
}: {
  open: boolean
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDocDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open, onClose])
  if (!open) return null
  return (
    <div
      ref={ref}
      className="absolute left-0 top-full z-50 mt-1 rounded-lg border border-gray-200 bg-white py-1 shadow-lg"
    >
      {children}
    </div>
  )
}

interface ToolButtonProps {
  icon: typeof Bold
  title: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}

function ToolButton({ icon: Icon, title, active, disabled, onClick }: ToolButtonProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-700',
        active && 'bg-green-50 text-green-600 hover:bg-green-50 hover:text-green-600',
        disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-gray-500'
      )}
    >
      <Icon className="h-4 w-4" />
    </button>
  )
}

/** 工具栏分组分隔线 */
function ToolbarDivider() {
  return <span className="mx-1 h-5 w-px shrink-0 bg-gray-200" />
}

export default function NoteEditor({ node, onClose }: NoteEditorProps) {
  const [content, setContent] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [headingOpen, setHeadingOpen] = useState(false)
  const [colorOpen, setColorOpen] = useState(false)

  // 保存相关 ref：onUpdate 回调里写，防抖/卸载兜底里读，避免闭包过期
  const dirtyRef = useRef(false)
  const htmlRef = useRef('')
  const saveTimerRef = useRef<number | null>(null)

  // 读取文件内容（父级按 node.id key，切文件即整体重挂载，此处无需处理切换残留）
  useEffect(() => {
    let cancelled = false
    setContent(null)
    setLoadError(null)
    window.api.library
      .readFile(node.id)
      .then((res) => {
        if (cancelled) return
        const raw = res.content ?? ''
        // 新文件是 .html 富文本片段；遗留 .md 纯文本转义后包 <p> 保证可编辑
        const html = /\.html?$/i.test(node.name) ? raw : `<p>${escapeHtml(raw)}</p>`
        setContent(html)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [node.id, node.name])

  // 立即保存（防抖计时到 / Ctrl+S / 卸载兜底共用）
  const doSave = useCallback((): void => {
    if (!dirtyRef.current) return
    dirtyRef.current = false
    setSaveState('saving')
    window.api.library
      .writeFile({ relPath: node.id, content: htmlRef.current })
      .then(() => setSaveState('saved'))
      .catch((err: unknown) => {
        // 保存失败：保留 dirty，供 Ctrl+S / 卸载兜底重试
        dirtyRef.current = true
        setSaveState('error')
        console.warn('保存笔记失败：', err)
      })
  }, [node.id])
  const doSaveRef = useRef(doSave)
  doSaveRef.current = doSave

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: '开始输入…' }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true })
    ],
    content: '',
    onUpdate: ({ editor: e }) => {
      dirtyRef.current = true
      htmlRef.current = e.getHTML()
      setSaveState('saving')
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      saveTimerRef.current = window.setTimeout(() => {
        saveTimerRef.current = null
        doSaveRef.current()
      }, 800)
    }
  })

  // 内容加载完成后推入编辑器（emitUpdate:false 不触发保存）
  useEffect(() => {
    if (editor && content !== null) {
      editor.commands.setContent(content, { emitUpdate: false })
      dirtyRef.current = false
      htmlRef.current = content
      setSaveState('saved')
    }
  }, [editor, content])

  // Ctrl/Cmd+S：立即保存（拦截浏览器默认保存）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        if (saveTimerRef.current) {
          window.clearTimeout(saveTimerRef.current)
          saveTimerRef.current = null
        }
        doSave()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [doSave])

  // 卸载兜底：关闭/切文件时若有未保存改动，直接落盘一次
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current)
      if (dirtyRef.current) {
        window.api.library
          .writeFile({ relPath: node.id, content: htmlRef.current })
          .catch(() => {})
      }
    }
  }, [node.id])

  // 工具栏 active 态：TipTap v3 默认不在事务时重渲，必须用 useEditorState 订阅
  const editorState = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      bulletList: e.isActive('bulletList'),
      orderedList: e.isActive('orderedList'),
      blockquote: e.isActive('blockquote'),
      codeBlock: e.isActive('codeBlock'),
      highlight: e.isActive('highlight'),
      color: e.getAttributes('textStyle').color as string | undefined,
      headingLevel: e.isActive('heading') ? (e.getAttributes('heading').level as number) : 0,
      canUndo: e.can().undo(),
      canRedo: e.can().redo()
    })
  })

  /** 工具栏命令统一入口：编辑器未就绪时静默跳过 */
  const run = useCallback(
    (fn: (e: Editor) => void): void => {
      if (editor) fn(editor)
    },
    [editor]
  )

  const headingLabel =
    HEADING_OPTIONS.find((o) => o.level === (editorState?.headingLevel ?? 0))?.label ?? '正文'

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-white">
      {/* 标题栏：文件名 + 保存状态 + 关闭 */}
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-gray-200 px-4">
        <FileText className="h-4 w-4 shrink-0 text-gray-400" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800" title={node.name}>
          {displayFileName(node.name)}
        </span>
        <span
          className={cn(
            'shrink-0 text-xs',
            saveState === 'saving' && 'text-gray-400',
            saveState === 'saved' && 'text-green-600',
            saveState === 'error' && 'text-red-600'
          )}
        >
          {saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '已保存' : '保存失败'}
        </span>
        <button
          type="button"
          onClick={onClose}
          title="关闭"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 工具栏 */}
      <div className="flex shrink-0 flex-wrap items-center gap-0.5 border-b border-gray-200 bg-white px-3 py-1.5">
        {/* 标题下拉 */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setHeadingOpen((v) => !v)
              setColorOpen(false)
            }}
            className="flex h-8 items-center gap-1 rounded-md px-2 text-xs text-gray-600 transition-colors hover:bg-gray-100"
          >
            {headingLabel}
            <ChevronDown className="h-3.5 w-3.5 text-gray-400" />
          </button>
          <Popover open={headingOpen} onClose={() => setHeadingOpen(false)}>
            {HEADING_OPTIONS.map((opt) => (
              <button
                key={opt.label}
                type="button"
                onClick={() => {
                  setHeadingOpen(false)
                  run((e) => {
                    if (opt.level === 0) e.chain().focus().setParagraph().run()
                    else
                      e.chain().focus().toggleHeading({ level: opt.level as 1 | 2 | 3 }).run()
                  })
                }}
                className={cn(
                  'flex w-28 items-center gap-2 px-3 py-1.5 text-left text-sm text-gray-700 transition-colors hover:bg-gray-50',
                  (editorState?.headingLevel ?? 0) === opt.level && 'text-green-600'
                )}
              >
                {opt.level === 0 && <Type className="h-4 w-4 text-gray-400" />}
                {opt.level === 1 && <Heading1 className="h-4 w-4 text-gray-400" />}
                {opt.level === 2 && <Heading2 className="h-4 w-4 text-gray-400" />}
                {opt.level === 3 && <Heading3 className="h-4 w-4 text-gray-400" />}
                {opt.label}
              </button>
            ))}
          </Popover>
        </div>

        <ToolbarDivider />

        <ToolButton
          title="加粗"
          icon={Bold}
          active={editorState?.bold}
          onClick={() => run((e) => e.chain().focus().toggleBold().run())}
        />
        <ToolButton
          title="斜体"
          icon={Italic}
          active={editorState?.italic}
          onClick={() => run((e) => e.chain().focus().toggleItalic().run())}
        />
        <ToolButton
          title="下划线"
          icon={Underline}
          active={editorState?.underline}
          onClick={() => run((e) => e.chain().focus().toggleUnderline().run())}
        />
        <ToolButton
          title="删除线"
          icon={Strikethrough}
          active={editorState?.strike}
          onClick={() => run((e) => e.chain().focus().toggleStrike().run())}
        />

        <ToolbarDivider />

        <ToolButton
          title="无序列表"
          icon={List}
          active={editorState?.bulletList}
          onClick={() => run((e) => e.chain().focus().toggleBulletList().run())}
        />
        <ToolButton
          title="有序列表"
          icon={ListOrdered}
          active={editorState?.orderedList}
          onClick={() => run((e) => e.chain().focus().toggleOrderedList().run())}
        />
        <ToolButton
          title="引用"
          icon={Quote}
          active={editorState?.blockquote}
          onClick={() => run((e) => e.chain().focus().toggleBlockquote().run())}
        />
        <ToolButton
          title="代码块"
          icon={Code2}
          active={editorState?.codeBlock}
          onClick={() => run((e) => e.chain().focus().toggleCodeBlock().run())}
        />

        <ToolbarDivider />

        {/* 文字颜色：自绘色板浮层 */}
        <div className="relative">
          <ToolButton
            title="文字颜色"
            icon={Palette}
            active={!!editorState?.color}
            onClick={() => {
              setColorOpen((v) => !v)
              setHeadingOpen(false)
            }}
          />
          <Popover open={colorOpen} onClose={() => setColorOpen(false)}>
            <div className="flex w-40 flex-wrap gap-2 p-2">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c.label}
                  type="button"
                  title={c.label}
                  onClick={() => {
                    setColorOpen(false)
                    run((e) => {
                      if (c.color) e.chain().focus().setColor(c.color).run()
                      else e.chain().focus().unsetColor().run()
                    })
                  }}
                  className="flex h-6 w-6 items-center justify-center rounded-full border border-gray-200 transition-transform hover:scale-110"
                  style={c.color ? { backgroundColor: c.color } : undefined}
                >
                  {!c.color && <RemoveFormatting className="h-3 w-3 text-gray-400" />}
                </button>
              ))}
            </div>
          </Popover>
        </div>
        <ToolButton
          title="高亮"
          icon={Highlighter}
          active={editorState?.highlight}
          onClick={() => run((e) => e.chain().focus().toggleHighlight().run())}
        />
        <ToolButton
          title="分割线"
          icon={Minus}
          onClick={() => run((e) => e.chain().focus().setHorizontalRule().run())}
        />

        <ToolbarDivider />

        <ToolButton
          title="撤销"
          icon={Undo2}
          disabled={!editorState?.canUndo}
          onClick={() => run((e) => e.chain().focus().undo().run())}
        />
        <ToolButton
          title="重做"
          icon={Redo2}
          disabled={!editorState?.canRedo}
          onClick={() => run((e) => e.chain().focus().redo().run())}
        />
        <ToolButton
          title="清除格式"
          icon={RemoveFormatting}
          onClick={() => run((e) => e.chain().focus().clearNodes().unsetAllMarks().run())}
        />
      </div>

      {/* 内容区：加载失败错误条 / 加载中 / 编辑器 */}
      <div className="na-editor min-h-0 flex-1 overflow-y-auto px-8 py-5">
        {loadError ? (
          <div className="mx-auto max-w-3xl rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
            打开文件失败：{loadError}
          </div>
        ) : content === null ? (
          <div className="mx-auto max-w-3xl text-xs text-gray-400">加载中…</div>
        ) : (
          <EditorContent editor={editor} className="mx-auto w-full max-w-3xl" />
        )}
      </div>
    </div>
  )
}

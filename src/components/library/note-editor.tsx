import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
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
import TextAlign from '@tiptap/extension-text-align'
import Image from '@tiptap/extension-image'
import { InlineMath, BlockMath } from '@tiptap/extension-mathematics'
import type { EditorProps, EditorView } from '@tiptap/pm/view'
import katex from 'katex'
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Bold,
  ChevronDown,
  Code2,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Highlighter,
  ImagePlus,
  Italic,
  List,
  ListOrdered,
  Minus,
  Palette,
  Quote,
  Redo2,
  RemoveFormatting,
  Sigma,
  SquareFunction,
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

/** 单张图片体积上限（base64 内嵌进 .html，过大拖垮保存/渲染） */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

interface NoteEditorProps {
  node: LibraryNode
  onClose: () => void
}

/** 公式编辑弹层状态：insert = 工具栏插入，edit = 点击已有公式 */
interface MathEditState {
  mode: 'insert' | 'edit'
  type: 'inline' | 'block'
  pos?: number
  latex: string
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

/**
 * 公式编辑弹层：LaTeX 输入 + 实时 KaTeX 预览。
 * 插入/编辑共用：insert 模式保存时插入新公式，edit 模式保存时更新/删除既有公式。
 */
function MathDialog({
  edit,
  draft,
  setDraft,
  onSave,
  onDelete,
  onClose
}: {
  edit: MathEditState
  draft: string
  setDraft: (v: string) => void
  onSave: () => void
  onDelete?: () => void
  onClose: () => void
}) {
  const previewRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // 实时 KaTeX 预览（displayMode 跟随块级/行内）
  useEffect(() => {
    const el = previewRef.current
    if (!el) return
    if (!draft.trim()) return
    try {
      katex.render(draft, el, { displayMode: edit.type === 'block', throwOnError: false })
    } catch {
      el.textContent = draft
    }
  }, [draft, edit.type])

  // 打开即聚焦输入框
  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  // Escape 关闭（backdrop onClick 关闭，见 na-knowledge-rag 的 React 19 坑）
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20"
      onClick={onClose}
    >
      <div
        className="flex w-[560px] flex-col overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部 */}
        <div className="flex items-center justify-between border-b border-gray-200/70 px-4 py-3">
          <span className="flex items-center gap-1.5 text-sm font-medium text-gray-800">
            {edit.type === 'block' ? <SquareFunction className="h-4 w-4 text-gray-400" /> : <Sigma className="h-4 w-4 text-gray-400" />}
            {edit.mode === 'edit' ? '编辑公式' : edit.type === 'block' ? '插入块级公式' : '插入行内公式'}
          </span>
          <button
            type="button"
            onClick={onClose}
            title="关闭"
            className="flex h-6 w-6 items-center justify-center rounded-md text-gray-400 transition-colors hover:bg-gray-100 hover:text-gray-600"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* 实时预览 */}
        <div className="border-b border-gray-200/70 bg-gray-50 px-4 py-3">
          <div className="relative">
            {!draft.trim() && (
              <span className="pointer-events-none absolute inset-0 flex items-center justify-center text-xs text-gray-400">
                公式预览
              </span>
            )}
            <div
              ref={previewRef}
              className={cn(
                'min-h-[2.5em] overflow-x-auto overflow-y-hidden py-1 text-center',
                edit.type === 'block' ? 'text-lg' : 'text-base'
              )}
            />
          </div>
        </div>

        {/* LaTeX 输入 */}
        <div className="px-4 py-3">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                e.preventDefault()
                onSave()
              }
            }}
            spellCheck={false}
            rows={3}
            placeholder={'输入 LaTeX 公式，如 \\frac{a}{b}、E = mc^2'}
            className="w-full resize-none rounded-md border border-gray-200 bg-white px-3 py-2 font-mono text-sm text-gray-800 outline-none transition-colors placeholder:text-gray-300 focus:border-green-500"
          />
          <div className="mt-1 text-xs text-gray-400">
            编辑区内直接输入 <code className="rounded bg-gray-100 px-1">$$x^2$$</code> 也会自动转成行内公式
          </div>
        </div>

        {/* 底部操作 */}
        <div className="flex items-center justify-between border-t border-gray-200/70 px-4 py-3">
          {onDelete ? (
            <button
              type="button"
              onClick={onDelete}
              className="h-9 rounded-lg px-3 text-xs font-medium text-red-600 transition-colors hover:bg-red-50"
            >
              删除公式
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-9 rounded-lg px-3 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-50"
            >
              取消
            </button>
            <button
              type="button"
              disabled={!draft.trim()}
              onClick={onSave}
              className="h-9 rounded-lg bg-green-500 px-3 text-xs font-medium text-white transition-colors hover:bg-green-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default function NoteEditor({ node, onClose }: NoteEditorProps) {
  const [content, setContent] = useState<string | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [headingOpen, setHeadingOpen] = useState(false)
  const [colorOpen, setColorOpen] = useState(false)
  // 公式编辑弹层
  const [mathEdit, setMathEdit] = useState<MathEditState | null>(null)
  const [mathDraft, setMathDraft] = useState('')
  // 图片插入错误（体积超限等）
  const [imageError, setImageError] = useState<string | null>(null)

  // 保存相关 ref：onUpdate 回调里写，防抖/卸载兜底里读，避免闭包过期
  const dirtyRef = useRef(false)
  const htmlRef = useRef('')
  const saveTimerRef = useRef<number | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)

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

  // 编辑器外部粘贴图片：读作 base64 data URL 内嵌（保持笔记单文件自包含）
  const handlePaste = useCallback((view: EditorView, event: ClipboardEvent): boolean => {
    const files = Array.from(event.clipboardData?.files ?? [])
    const imgFile = files.find((f) => f.type.startsWith('image/'))
    if (!imgFile) return false
    const imageNode = view.state.schema.nodes.image
    if (!imageNode) return false
    if (imgFile.size > MAX_IMAGE_BYTES) {
      return false // 超限不插入，交给默认粘贴行为
    }
    const reader = new FileReader()
    reader.onload = () => {
      const src = reader.result
      if (typeof src !== 'string') return
      const node = imageNode.create({ src, alt: imgFile.name })
      view.dispatch(view.state.tr.replaceSelectionWith(node))
    }
    reader.readAsDataURL(imgFile)
    return true
  }, [])
  const editorProps = useMemo<EditorProps>(() => ({ handlePaste }), [handlePaste])

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: '开始输入…' }),
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      // 对齐：段落/标题可设 text-align 属性
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      // 图片：允许 base64 data URL，保证内嵌图片能重新解析回编辑器
      Image.configure({ allowBase64: true }),
      // 公式：行内/块级分开配置各自的 displayMode；onClick 打开编辑弹层
      InlineMath.configure({
        katexOptions: { displayMode: false, throwOnError: false },
        onClick: (node, pos) => {
          setMathEdit({ mode: 'edit', type: 'inline', pos, latex: node.attrs.latex })
          setMathDraft(node.attrs.latex)
        }
      }),
      BlockMath.configure({
        katexOptions: { displayMode: true, throwOnError: false },
        onClick: (node, pos) => {
          setMathEdit({ mode: 'edit', type: 'block', pos, latex: node.attrs.latex })
          setMathDraft(node.attrs.latex)
        }
      })
    ],
    editorProps,
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

  /** 工具栏命令统一入口：编辑器未就绪时静默跳过 */
  const run = useCallback(
    (fn: (e: Editor) => void): void => {
      if (editor) fn(editor)
    },
    [editor]
  )

  // 打开插入弹层（工具栏按钮）
  const openMathInsert = useCallback((type: 'inline' | 'block'): void => {
    setMathEdit({ mode: 'insert', type, latex: '' })
    setMathDraft('')
  }, [])

  // 保存公式：insert 模式插入新公式；edit 模式更新既有公式
  const mathSave = useCallback((): void => {
    if (!mathEdit) return
    const latex = mathDraft.trim()
    if (!latex) return
    run((e) => {
      if (mathEdit.mode === 'insert') {
        if (mathEdit.type === 'inline') e.chain().focus().insertInlineMath({ latex }).run()
        else e.chain().focus().insertBlockMath({ latex }).run()
      } else if (mathEdit.pos != null) {
        if (mathEdit.type === 'inline') e.chain().focus().updateInlineMath({ latex, pos: mathEdit.pos }).run()
        else e.chain().focus().updateBlockMath({ latex, pos: mathEdit.pos }).run()
      }
    })
    setMathEdit(null)
  }, [mathEdit, mathDraft, run])

  // 删除公式（仅编辑模式）
  const mathDelete = useCallback((): void => {
    if (!mathEdit || mathEdit.mode !== 'edit' || mathEdit.pos == null) return
    const pos = mathEdit.pos
    run((e) => {
      if (mathEdit.type === 'inline') e.chain().focus().deleteInlineMath({ pos }).run()
      else e.chain().focus().deleteBlockMath({ pos }).run()
    })
    setMathEdit(null)
  }, [mathEdit, run])

  // 选择本地图片 → 读为 base64 data URL 插入
  const handleImageFile = useCallback(
    (e: ChangeEvent<HTMLInputElement>): void => {
      const file = e.target.files?.[0]
      e.target.value = '' // 允许重复选择同一文件
      if (!file) return
      if (file.size > MAX_IMAGE_BYTES) {
        setImageError(`图片超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB，请压缩后重试`)
        return
      }
      const reader = new FileReader()
      reader.onload = () => {
        const src = reader.result
        if (typeof src !== 'string') return
        run((ed) => ed.chain().focus().setImage({ src, alt: file.name }).run())
        setImageError(null)
      }
      reader.readAsDataURL(file)
    },
    [run]
  )

  // 图片错误提示几秒后自动消失
  useEffect(() => {
    if (!imageError) return
    const t = window.setTimeout(() => setImageError(null), 4000)
    return () => window.clearTimeout(t)
  }, [imageError])

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
      alignLeft: e.isActive({ textAlign: 'left' }),
      alignCenter: e.isActive({ textAlign: 'center' }),
      alignRight: e.isActive({ textAlign: 'right' }),
      alignJustify: e.isActive({ textAlign: 'justify' }),
      canUndo: e.can().undo(),
      canRedo: e.can().redo()
    })
  })

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

        {/* 文字对齐 */}
        <ToolButton
          title="左对齐"
          icon={AlignLeft}
          active={editorState?.alignLeft}
          onClick={() => run((e) => e.chain().focus().toggleTextAlign('left').run())}
        />
        <ToolButton
          title="居中对齐"
          icon={AlignCenter}
          active={editorState?.alignCenter}
          onClick={() => run((e) => e.chain().focus().toggleTextAlign('center').run())}
        />
        <ToolButton
          title="右对齐"
          icon={AlignRight}
          active={editorState?.alignRight}
          onClick={() => run((e) => e.chain().focus().toggleTextAlign('right').run())}
        />
        <ToolButton
          title="两端对齐"
          icon={AlignJustify}
          active={editorState?.alignJustify}
          onClick={() => run((e) => e.chain().focus().toggleTextAlign('justify').run())}
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

        {/* 图片 / 公式 */}
        <ToolButton
          title="插入图片"
          icon={ImagePlus}
          onClick={() => imageInputRef.current?.click()}
        />
        <ToolButton
          title="行内公式"
          icon={Sigma}
          onClick={() => openMathInsert('inline')}
        />
        <ToolButton
          title="块级公式"
          icon={SquareFunction}
          onClick={() => openMathInsert('block')}
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

      {/* 图片错误提示条 */}
      {imageError && (
        <div className="shrink-0 border-b border-red-200 bg-red-50 px-3 py-1 text-xs text-red-600">
          {imageError}
        </div>
      )}

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

      {/* 图片文件选择（隐藏 input，触发系统文件框） */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleImageFile}
      />

      {/* 公式编辑弹层 */}
      {mathEdit && (
        <MathDialog
          edit={mathEdit}
          draft={mathDraft}
          setDraft={setMathDraft}
          onSave={mathSave}
          onDelete={mathEdit.mode === 'edit' ? mathDelete : undefined}
          onClose={() => setMathEdit(null)}
        />
      )}
    </div>
  )
}

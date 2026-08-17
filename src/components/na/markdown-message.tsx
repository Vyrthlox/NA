import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
// KaTeX 样式已全局引入（src/main.tsx），此处不再重复导入

interface MarkdownMessageProps {
  content: string
}

const components: Components = {
  // 外链不在应用窗口内导航：阻止默认跳转，转交系统浏览器（主进程 setWindowOpenHandler 已拦截 window.open）
  a: ({ href, children }) => (
    <a
      href={href}
      onClick={(e) => {
        if (!href) return
        e.preventDefault()
        window.open(href, '_blank')
      }}
    >
      {children}
    </a>
  )
}

/** 对话回复的 Markdown 排版：GFM（表格/任务列表/删除线）+ KaTeX 数学公式渲染。
 *  流式期间内容是部分 Markdown，未闭合的 $ 会作为纯文本显示，闭合后才转公式，不会抛错。 */
export function MarkdownMessage({ content }: MarkdownMessageProps) {
  return (
    <div className="na-md break-words">
      <ReactMarkdown
        remarkPlugins={[remarkMath, remarkGfm]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}

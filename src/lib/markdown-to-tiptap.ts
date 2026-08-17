import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeStringify from 'rehype-stringify'
import type { Element } from 'hast'

/**
 * 将模型整理回复的 Markdown 转为与文件库内 TipTap 编辑器一致的富文本 HTML。
 *
 * 语义：
 * - 标题/列表/代码块/引用/加粗/斜体/分隔线/链接 → 对应标准 HTML 标签
 * - 行内公式 $...$ → <span data-type="inline-math" data-latex="…">
 * - 块级公式 $$...$$ → <div data-type="block-math" data-latex="…">
 *   （TipTap mathematics 扩展按 data-type / data-latex 解析，可在编辑器内继续编辑公式）
 */

/**
 * 单行 `$$...$$` 归一化为块级公式围栏形式。
 * remark-math 把单行 `$$x$$` 解析成行内公式；模型常用单行 `$$...$$` 表示展示公式。
 * 用换行把 `$$` 围栏独立成行，才能被识别为块级公式（data-type="block-math"）。
 * 已是的 `$$/$$` 围栏形式（$$ 独占一行）不会被该正则匹配，保持原样。
 */
function normalizeBlockMath(markdown: string): string {
  return markdown.replace(/\$\$(.+?)\$\$/g, (_, latex: string) => `\n$$\n${latex}\n$$\n`)
}

/** remark-math 的行内公式节点：{ type: 'inlineMath', value: string } */
function inlineMathToHast(_state: unknown, node: { value?: string }): Element {
  return {
    type: 'element',
    tagName: 'span',
    properties: { 'data-type': 'inline-math', 'data-latex': node.value ?? '' },
    children: [],
  }
}

/** remark-math 的块级公式节点：{ type: 'math', value: string } */
function mathToHast(_state: unknown, node: { value?: string }): Element {
  return {
    type: 'element',
    tagName: 'div',
    properties: { 'data-type': 'block-math', 'data-latex': node.value ?? '' },
    children: [],
  }
}

export async function markdownToTiptapHtml(markdown: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkRehype, {
      // remark-rehype 处理器签名为 (state, node, parent)，第一个参数是 state 而非 mdast 节点
      handlers: {
        inlineMath: inlineMathToHast as never,
        math: mathToHast as never,
      } as never,
    })
    .use(rehypeStringify)
    .process(normalizeBlockMath(markdown))
  return String(file)
}

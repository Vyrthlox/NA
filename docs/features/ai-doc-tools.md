# AI 文档工具（AI Doc Tools）

> 模块：Renderer `chat-input.tsx`（快捷能力）、`organize-save-dialog.tsx`、`use-chat.ts`（@organize 落盘）、`src/lib/markdown-to-tiptap.ts`、Sidecar `finalize_organize_turn`。
> 本文档描述应用内置的 AI 文档能力：快捷写作/翻译/总结/图片，以及「将对话整理为文档」（@organize）的完整链路。
> 状态：✅ 已实现。

## 1. 快捷能力（chat-input 快捷按钮）

输入区提供四个快捷能力，本质是**预置系统提示**，把普通消息变成指定任务：

| 按钮 | 命令提示 | 用途 |
|------|---------|------|
| 帮我写作 | `write` | 从零撰写/续写 |
| 内容翻译 | `translate` | 翻译输入内容（文档翻译等子选项） |
| 文档总结 | `summarize` | 对粘贴内容/上传附件做总结 |
| 图片生成 | `image` | 走视觉模型（qwen）生成/理解图片 |

与普通对话同链路（SSE 流式，见 [chat-pipeline.md](chat-pipeline.md)），只是以快捷命令开头。

## 2. 将对话整理为文档（@organize）

### 2.1 交互（三步浮层）

点击输入区「整理文档」按钮：

1. **选择/新建目标路径**：在文件库树中选目标目录，或手动输入相对路径（可含空格，根为 `data/library/`）。
2. **命名**：默认文件名 `对话整理-YYYYMMDD-HHmm.html`，可改。
3. **确认**：确认后发送 `@organize <相对路径>` 命令消息。

> 所有浮层均为自绘组件（`organize-save-dialog.tsx`），因为 **Electron renderer 中 `window.confirm/alert/prompt` 被抑制**——应用内交互一律自绘浮层（右键菜单/命名输入/确认框同理）。

### 2.2 命令与收尾

- 命令形态：`@organize <相对路径>`（`ORGANIZE_RE = /^@organize\s+(.+)$/`）。
- sidecar 侧：`is_organize = bool(re.match(r"^@organize\s+", message))` → 走 **`finalize_organize_turn`** 专用收尾——不做上下文拆卸、不做长期记忆沉降（整理不是普通对话轮次，`kind=organize` 不进入分级）。
- 模型回复应为整份文档正文（系统提示要求 `$...$`/`$$...$$` 写公式）。

### 2.3 Markdown → TipTap HTML 转换（落盘前）

`src/lib/markdown-to-tiptap.ts`（unified + remark-parse/gfm/math + remark-rehype + rehype-stringify）：

- 标题/列表/代码块/引用/加粗/斜体/分隔线/链接 → 标准 HTML 标签（编辑器可继续编辑）。
- 行内公式 `$...$` → `<span data-type="inline-math" data-latex="…">`。
- 块级公式 `$$...$$` → `<div data-type="block-math" data-latex="…">`。

**两个关键坑**（已在实现中修复）：

1. **remark-rehype 处理器签名**：handler 收到 `(state, node, parent)`，第一个参数是 `state` 而非 mdast 节点；写错会把 `node.value` 取空，产出 `<span data-latex=""></span>`。正确写法 `(_state, node)`。
2. **单行 `$$x$$` 被解析成行内**：remark-math v6 只有 `$$` 独占一行的围栏形式才是块级 `math` 节点；单行 `$$...$$` 被当作 `inlineMath`。需要预处理 `normalizeBlockMath`：`markdown.replace(/\$\$(.+?)\$\$/g, (_, latex) => '\n$$\n' + latex + '\n$$\n')`——用换行把 `$$` 围栏独立成行。

转换产物直接写 `library:write-organize({relPath, content})`（创建或覆盖目标文件），随后：

- renderer 派发 `library:changed` → 文件库面板刷新；
- 输入区显示保存成功反馈条（`organizeResult`）；失败显示原因并保留路径。

## 3. 系统提示（Prompt/SystemPrompt.md）

- `@organize` 段：说明文档保存为应用内富文本（`.html`）、公式用 `$...$`/`$$...$$`、应输出整份文档正文。
- 快捷能力段：分别为写作/翻译/总结/图片定义输出要求。

## 4. 与文件库的关系

- 目标路径根为文件库 `data/library/`，与用户手动建的文件同构（`.html` 富文本）。
- 整理产物在编辑器内可继续编辑公式与排版：见 [file-library.md](file-library.md)。

## 5. 关联文档

- 对话转发与 done 事件（@organize 在 done 里落盘）：见 [chat-pipeline.md](chat-pipeline.md)。
- 编辑器与文件库：见 [file-library.md](file-library.md)。

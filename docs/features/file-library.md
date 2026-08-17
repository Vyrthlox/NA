# 文件库与富文本编辑器（File Library & TipTap Editor）

> 模块：Renderer `src/components/na/note-editor.tsx`、`use-library.ts`、Main `electron/main/library/`。
> 本文档描述应用内文档的存储形态、文件库面板、TipTap 富文本编辑器的实现要点（含公式/图片/对齐）。
> 状态：✅ 已实现（含 AI 整理文档写入）。

## 1. 存储形态

- **根目录**：`data/library/`（gitignored 的运行时数据）。
- **文件格式**：TipTap 兼容的 **富文本 `.html`**（非 markdown）。文件名由 `createFile` 自动补 `.html`。
- **目录**：支持任意多级子目录（`data/library/设计文档/需求.html`）。

## 2. 文件库 IPC

| 通道 | 说明 |
|------|------|
| `library:list` | 列出库树（目录 + 文件） |
| `library:create-folder` | 新建目录 |
| `library:create-file` | 新建文件（自动补 `.html` 扩展名） |
| `library:delete-folder` | 删除目录（递归） |
| `library:delete-file` | 删除文件 |
| `library:read-file` | 读文件内容（HTML） |
| `library:write-file` | 保存编辑内容 |
| `library:write-organize` | AI 整理文档专用写入（创建或覆盖目标文件） |

**刷新机制**：外部写入（如 `@organize` 落盘）通过 renderer 派发自定义 `library:changed` 事件 → `use-library.ts` 监听后 `refresh()`，文件库面板立刻出现新文档。

## 3. TipTap 富文本编辑器（note-editor.tsx）

- **存储**：`.html`，**800ms 防抖自动保存**（输入停顿后写 `library:write-file`），未保存状态在标题栏提示。
- **状态订阅**：TipTap **v3** 需要 `useEditorState` 订阅才能让工具栏按钮（加粗/斜体/标题等）正确反映激活态——v2 的 `useEditor` 直接返回 editor 的写法在 v3 不适用。
- **公式（mathematics 扩展）**：
  - 行内公式 → `<span data-type="inline-math" data-latex="…">`；
  - 块级公式 → `<div data-type="block-math" data-latex="…">`；
  - `InlineMath` / `BlockMath` 必须**分别配置**（不能只用 mathematics 默认注册其中一个）；
  - 渲染用 `katex.render`，编辑态可点进公式编辑 LaTeX 原文。
- **图片**：`allowBase64` 开启 → 粘贴/插入图片以 **base64 内嵌**进 HTML（单文件自包含，无外部资源依赖）。
- **对齐**：`TextAlign` 扩展（左/中/右）。
- 其它常用扩展：标题、列表、引用、代码块、分隔线、链接等。

## 4. 与 AI 功能的接口

- AI「整理文档」把模型 Markdown 回复转成 **同一套 TipTap HTML 结构** 后落盘（`markdown-to-tiptap.ts` 的转换：标题/列表/代码块 → 标准标签；`$...$` → inline-math；`$$...$$` → block-math），因此整理产物在编辑器里**可继续编辑公式与排版**。详见 [ai-doc-tools.md](ai-doc-tools.md)。
- 文件库是 `@organize` 的目标路径解析根（相对路径即可含空格）。

## 5. 关联文档

- AI 文档工具与整理落盘：见 [ai-doc-tools.md](ai-doc-tools.md)。
- 数据存储总览：见 `docs/client-architecture.md` §10。

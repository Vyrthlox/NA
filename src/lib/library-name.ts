/** 展示用的文件名：去掉最后一个扩展名（如 "数学笔记.html" → "数学笔记"、"设计.v2.html" → "设计.v2"）。点号开头（隐藏文件）不处理 */
export function displayFileName(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 ? name.slice(0, i) : name
}

/**
 * 知识库上传格式白名单（前端单一事实来源）。
 * 与 sidecar/services/knowledge/store.py 的 ALLOWED_EXTS 保持一致（后端仍会二次校验）。
 * 面板 accept / 应用内选择器过滤 / 提示文案都从这里取，避免三处手写不同步。
 */

export const KB_ALLOWED_EXTS = ['.docx', '.pdf', '.txt', '.md', '.html', '.htm', '.csv', '.json']
export const KB_ACCEPT = KB_ALLOWED_EXTS.join(',')
/** 供提示文案使用的不含点号列表 */
export const KB_ALLOWED_LABEL = KB_ALLOWED_EXTS.map((e) => e.slice(1)).join(' / ')

export function fileExt(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

/** 扩展名 → MIME（仅上传载荷 wire 字段用；后端按扩展名分派，MIME 是提示性的） */
export function mimeFromExt(name: string): string {
  switch (fileExt(name)) {
    case '.html':
    case '.htm':
      return 'text/html'
    case '.md':
      return 'text/markdown'
    case '.txt':
      return 'text/plain'
    case '.csv':
      return 'text/csv'
    case '.json':
      return 'application/json'
    case '.pdf':
      return 'application/pdf'
    case '.docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    default:
      return 'application/octet-stream'
  }
}

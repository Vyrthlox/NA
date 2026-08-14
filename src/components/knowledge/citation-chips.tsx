import { FileText } from 'lucide-react'

interface CitationChipsProps {
  citations: KnowledgeCitation[]
}

/** 引用 chips：回答下方的来源标注（[序号] 文档路径）；空/无引用时返回 null */
export function CitationChips({ citations }: CitationChipsProps) {
  if (!citations || citations.length === 0) return null
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-gray-100 pt-3">
      {citations.map((c) => (
        <span
          key={c.chunk_id}
          title={c.doc_id + (c.section ? ` · ${c.section}` : '')}
          className="inline-flex max-w-full items-center gap-1 rounded-lg bg-gray-50 px-2 py-1 text-xs text-gray-500"
        >
          <FileText className="h-3 w-3 shrink-0 text-gray-400" />
          <span className="truncate">[{c.rank}] {c.doc_id}</span>
        </span>
      ))}
    </div>
  )
}

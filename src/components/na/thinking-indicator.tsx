/** AI 思考中指示：线框正方体沿体对角线旋转 + 上下小幅跳动 */
export function ThinkingIndicator() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-3 rounded-2xl border border-gray-200/80 bg-white px-4 py-3">
        {/* 外层负责上下跳动，内层负责沿体对角线旋转 */}
        <div className="na-thinking-cube-bounce">
          <div className="na-thinking-cube-spin">
            <div className="na-thinking-cube-face na-thinking-cube-face-front" />
            <div className="na-thinking-cube-face na-thinking-cube-face-back" />
            <div className="na-thinking-cube-face na-thinking-cube-face-right" />
            <div className="na-thinking-cube-face na-thinking-cube-face-left" />
            <div className="na-thinking-cube-face na-thinking-cube-face-top" />
            <div className="na-thinking-cube-face na-thinking-cube-face-bottom" />
          </div>
        </div>
        <span className="text-sm text-gray-500">思考中…</span>
      </div>
    </div>
  )
}

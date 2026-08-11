// CDP 全链路：真实上传 md+docx → 发送带附件消息 → 验证 AI 引用文件内容 + chips 清空
import fs from 'node:fs'

const wsUrl = process.argv[2]
const files = process.argv.slice(3) // 上传文件绝对路径

const ws = new WebSocket(wsUrl)
let id = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    pending.set(msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
  }
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails))
  return res.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej })
await send('Page.enable')
await send('Runtime.enable')
await send('DOM.enable')

// 1) 等 sidecar ready
for (let i = 0; i < 30; i++) {
  const ph = await evaluate(`document.querySelector('textarea')?.placeholder ?? ''`)
  if (ph === '向 NA 提问…') { console.log('[ready] 输入框就绪'); break }
  await sleep(1000)
}

// 2) 真实上传：DOM.setFileInputFiles 触发 change → 走真实上传链路
const { root } = await send('DOM.getDocument', { depth: -1 })
const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: 'input[type=file]' })
if (!nodeId) throw new Error('找不到文件输入框')
await send('DOM.setFileInputFiles', { nodeId, files })
console.log(`[upload] 已设置 ${files.length} 个文件 → 等待 chips`)

// 等 2 个附件 chip 出现
let chips = 0
for (let i = 0; i < 30; i++) {
  chips = await evaluate(`(() => {
    const ta = document.querySelector('textarea')
    const prev = ta.value // 触发 React 渲染同步
    return document.querySelectorAll('button[title="移除附件"]').length
  })()`)
  if (chips >= files.length) break
  await sleep(500)
}
console.log(`[chips] ${chips} 个附件已显示`)

// 3) 输入问题并发送
await evaluate(`(() => {
  const ta = document.querySelector('textarea')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '请总结我附带两个文件的内容，并指出各自的关键信息')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return ta.value
})()`)
await sleep(300)
const clicked = await evaluate(`(() => {
  const btn = document.querySelector('button[title="发送"]')
  if (!btn || btn.disabled) return 'send-not-ready'
  btn.click(); return 'sent'
})()`)
console.log(`[send] ${clicked}`)

// 4) 发送后 chips 应立即清空（每消息语义）
await sleep(800)
const chipsAfter = await evaluate(`document.querySelectorAll('button[title="移除附件"]').length`)
console.log(`[chips-after-send] ${chipsAfter}（应为 0）`)

// 5) 等流式结束，取最终回复
let reply = ''
for (let i = 0; i < 120; i++) {
  const done = await evaluate(`!document.querySelector('button[title="停止生成"]')`)
  if (done) break
  await sleep(1000)
}
reply = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('.flex.justify-start .whitespace-pre-wrap')]
  return rows.map(d => (d.textContent || '').trim()).filter(Boolean).join('\\n---\\n')
})()`)
console.log('=== AI 回复 ===')
console.log(reply)

// 6) 校验标志句
const mdMarker = 'MD附件冒烟测试'
const docxMarker = 'DOCX附件冒烟测试'
console.log(`\n=== 校验 ===`)
console.log(`回复含「${mdMarker}」: ${reply.includes(mdMarker)}`)
console.log(`回复含「${docxMarker}」: ${reply.includes(docxMarker)}`)
console.log(`chips 已清空: ${chipsAfter === 0}`)

ws.close()
process.exit(0)

// CDP 驱动：输入问题 → 发送 → 捕获「思考中」线框立方体动画
// 用法：node na-thinking-driver.mjs <webSocketDebuggerUrl> <截图输出目录>
import fs from 'node:fs'
import path from 'node:path'

const wsUrl = process.argv[2]
const outDir = process.argv[3] ?? '.'
if (!wsUrl) {
  console.error('缺少 webSocketDebuggerUrl')
  process.exit(1)
}

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
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
  }
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails))
  return res.result.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(outDir, name)
  fs.writeFileSync(file, Buffer.from(data, 'base64'))
  console.log(`📸 ${file}`)
}

await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})
await send('Page.enable')
await send('Runtime.enable')

// 1) 等待 sidecar ready（placeholder 变为可提问）
for (let i = 0; i < 30; i++) {
  const ph = await evaluate(`document.querySelector('textarea')?.placeholder ?? ''`)
  console.log(`[${i}] placeholder: "${ph}"`)
  if (ph === '向 NA 提问…') break
  await sleep(1000)
}

// 2) 注入问题文本（native setter 触发 React onChange）
const typed = await evaluate(`(() => {
  const ta = document.querySelector('textarea')
  if (!ta) return 'no-textarea'
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, '用一句话介绍 NA 是什么')
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return 'typed:' + ta.value
})()`)
console.log('TYPE', typed)
await sleep(300)

// 3) 点击发送
const clicked = await evaluate(`(() => {
  const btn = document.querySelector('button[title="发送"]')
  if (!btn || btn.disabled) return 'send-btn not ready'
  btn.click()
  return 'clicked-send'
})()`)
console.log('SEND', clicked)

// 4) 轮询：等待思考动画出现，然后连续截图展示旋转+跳动
let sawCube = false
for (let i = 0; i < 50; i++) {
  const st = await evaluate(`(() => {
    const cube = document.querySelector('.na-thinking-cube-spin')
    const thinking = [...document.querySelectorAll('span')].some(s => s.textContent.trim() === '思考中…')
    const userMsg = [...document.querySelectorAll('div')].some(d => d.textContent.trim() === '用一句话介绍 NA 是什么')
    return { cube: !!cube, thinking, userMsg, stopping: !!document.querySelector('button[title="停止生成"]') }
  })()`)
  if (st.cube) {
    sawCube = true
    console.log(`[${i}] THINKING VISIBLE`, JSON.stringify(st))
    await shot('thinking-1.png')
    await sleep(320)
    await shot('thinking-2.png')
    await sleep(320)
    await shot('thinking-3.png')
    break
  }
  if (st.thinking === false && st.stopping === true && !sawCube) {
    console.log(`[${i}] 未捕获到思考动画，但已在流式输出`, JSON.stringify(st))
    await shot('stream-only.png')
    break
  }
  await sleep(250)
}

// 5) 等流式结束，截最终结果
for (let i = 0; i < 60; i++) {
  const done = await evaluate(`!document.querySelector('button[title="停止生成"]')`)
  if (done) break
  await sleep(1000)
}
await shot('after-done.png')
console.log('DONE')

ws.close()
process.exit(0)

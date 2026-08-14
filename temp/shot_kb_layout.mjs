// CDP 截图验证：知识库页三栏布局（列表态 + 选中详情态）
// 用法: node temp/shot_kb_layout.mjs <wsUrl>
const wsUrl = process.argv[2]
if (!wsUrl) { console.error('usage: node temp/shot_kb_layout.mjs <webSocketDebuggerUrl>'); process.exit(1) }

const ws = new WebSocket(wsUrl)
let seq = 0
const pending = new Map()
function send(method, params = {}) {
  const id = ++seq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(msg.error.message)); else resolve(msg.result)
  }
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error('evaluate error: ' + JSON.stringify(r.exceptionDetails))
  return r.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function waitFor(desc, fn, timeoutMs = 20000) {
  const t0 = Date.now()
  for (;;) {
    try { const v = await fn(); if (v) return v } catch { /* poll */ }
    if (Date.now() - t0 > timeoutMs) throw new Error('TIMEOUT waiting for ' + desc)
    await sleep(500)
  }
}
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  const fs = await import('node:fs')
  fs.writeFileSync(`temp/${name}.png`, Buffer.from(data, 'base64'))
  console.log(`shot saved: temp/${name}.png`)
}

ws.onopen = async () => {
  try {
    await send('Runtime.enable')
    await send('Page.enable')
    await send('DOM.enable')
    // 缩小设备缩放比 → 输出更小 PNG，便于工具预览
    await send('Emulation.setDeviceMetricsOverride', { width: 1266, height: 763, deviceScaleFactor: 0.55, mobile: false })

    // 若不在知识库页则点导航进入
    await evaluate(`(() => { if ([...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='新建知识库')) return true; const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='知识库'); b?.click(); return true })()`)
    await waitFor('新建知识库按钮', () => evaluate(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='新建知识库')`))

    // 若上次选中遗留了详情面板，先点右上角关闭 → 回到列表态
    await evaluate(`(() => { const close=[...document.querySelectorAll('button')].find(b=>b.title==='关闭'); if (close) close.click(); return true })()`)
    await waitFor('回到未选中态', () => evaluate(`!document.querySelector('button[title^="上传文件"]')`))

    // 布局尺寸探针
    const probe = await evaluate(`(() => {
      const nav = document.querySelector('aside') // App 外层 sidebar
      const cols = [...document.querySelectorAll('div')].filter(d=>d.className.includes && d.className.includes('min-h-0 flex-1'))
      return { winW: innerWidth, winH: innerHeight }
    })()`)
    console.log('window', probe)

    // 1) 列表态（未选中 KB）
    const kbRows = await evaluate(`(() => {
      const rows = [...document.querySelectorAll('aside button')].filter(b=>(b.title||'').includes('文件 ·'))
      return rows.length
    })()`)
    console.log('KB rows:', kbRows)
    await shot('kb_layout_list')

    // 2) 若存在 KB，点击第一行 → 详情态
    if (kbRows > 0) {
      await evaluate(`(() => {
        const row=[...document.querySelectorAll('aside button')].find(b=>(b.title||'').includes('文件 ·'))
        row?.click(); return true
      })()`)
      await waitFor('详情面板出现', () => evaluate(`!!document.querySelector('button[title^="上传文件"]')`))
      await sleep(800)
      await shot('kb_layout_detail')
    }
    console.log('=== 截图完成 ===')
    process.exit(0)
  } catch (err) {
    console.error('=== 截图失败 ===', err)
    process.exit(1)
  }
}
ws.onerror = (e) => { console.error('ws error', e); process.exit(1) }

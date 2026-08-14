const wsUrl = process.argv[2]
const ws = new WebSocket(wsUrl)
let seq = 0
const pending = new Map()
function send(method, params = {}) { const id = ++seq; ws.send(JSON.stringify({ id, method, params })); return new Promise((res, rej) => pending.set(id, { resolve: res, reject: rej })) }
ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } }
async function evaluate(expression) { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('evaluate error: ' + JSON.stringify(r.exceptionDetails)); return r.result?.value }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
ws.onopen = async () => {
  try {
    await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable')
    // 确保在知识库页且已选中一个 KB（详情态）
    await evaluate(`(() => { if ([...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='新建知识库')) return true; const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='知识库'); b?.click(); return true })()`)
    await sleep(800)
    const clicked = await evaluate(`(() => { const row=[...document.querySelectorAll('aside button')].find(b=>(b.title||'').includes('文件 ·')); if(row){ row.click(); return true } return false })()`)
    await sleep(800)
    const probe = await evaluate(`(() => {
      const box = (el) => { if(!el) return null; const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } }
      const sidebar = document.querySelector('aside') // App 外层导航
      const mid = [...document.querySelectorAll('aside')].find(a => Math.round(a.getBoundingClientRect().width) === 256)
      const detail = [...document.querySelectorAll('aside')].find(a => a !== sidebar && a !== mid && (a.title === undefined || a === mid))
      // 详情面板 = 非 sidebar、非中间列的 aside
      const panels = [...document.querySelectorAll('aside')].filter(a => a !== sidebar && a !== mid).map(box)
      const header = [...document.querySelectorAll('header')].find(h => h.textContent.includes('知识库'))
      const rows = [...document.querySelectorAll('aside button')].filter(b=>(b.title||'').includes('文件 ·')).length
      const uploadBtn = !!document.querySelector('button[title^="上传文件"]')
      const closeBtn = !![...document.querySelectorAll('button')].find(b=>b.title==='关闭')
      const fileRows = [...document.querySelectorAll('aside button')].filter(b=>(b.title||'').includes('.html')||(b.title||'').includes('.txt')||(b.title||'').includes('.md')).length
      return { winW: innerWidth, winH: innerHeight, sidebar: box(sidebar), midCol: box(mid), header: box(header), panels, rows, uploadBtn, closeBtn, fileRows }
    })()`)
    console.log(JSON.stringify(probe, null, 2))
    process.exit(0)
  } catch (e) { console.error(e); process.exit(1) }
}

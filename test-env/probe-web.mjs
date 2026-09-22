// 探测隔离 web API（门禁4验证）——先换 cookie 再探测
const base = 'http://127.0.0.1:1750'
const token = 'E7FF3GHyhcxtoGNqLKYMQWVEpCjRsj-w8obL2B-0X7M'

// 首次 GET /?token= 换取 cookie
let cookie = ''
{
  const res = await fetch(`${base}/?token=${token}`, { redirect: 'manual' })
  const setCookie = res.headers.getSetCookie?.() ?? []
  cookie = setCookie.map((c) => c.split(';')[0]).join('; ')
  console.log('index status:', res.status, 'cookie:', cookie ? 'acquired' : 'none')
}

async function probe(path) {
  try {
    const res = await fetch(`${base}${path}`, { headers: { cookie } })
    const text = await res.text()
    console.log(`${path}: ${res.status} ${text.slice(0, 160)}`)
  } catch (e) {
    console.log(`${path}: ERR ${e.message}`)
  }
}

await probe('/api/health')
await probe('/api/sessions')
await probe('/api/session/list')
await probe('/api/tools')

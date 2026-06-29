// Vercel Serverless Function：WebDAV 反向代理
// 解决浏览器 CORS 限制——网页请求 /api/webdav/...，由服务端转发到目标 WebDAV 服务器。
// 目标地址通过请求头 X-WebDAV-Target 传入（前端设置），或回退到坚果云。

export const config = {
  runtime: 'nodejs',
}

// 允许的 WebDAV 域名白名单（防止代理被滥用做开放中转）
const ALLOWED_HOSTS = [
  'dav.jianguoyun.com',
  'dav.box.com',
  'webdav.4shared.com',
  'nanaooo.com',
]

function getAllowedHosts(): string[] {
  const custom = (process.env.WEBDAV_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
  return [...ALLOWED_HOSTS, ...custom]
}

function isAllowed(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    const hostname = u.hostname.toLowerCase()
    return getAllowedHosts().some((h) => hostname === h || hostname.endsWith('.' + h))
  } catch {
    return false
  }
}

export default async function handler(req: any, res: any) {
  // 只允许标准 WebDAV 方法
  const method = req.method || 'GET'

  // 目标地址：优先从自定义请求头读取，回退坚果云
  const targetBase = (req.headers['x-webdav-target'] || '').replace(/\/$/, '')
  const targetUrl = targetBase || 'https://dav.jianguoyun.com/dav'

  if (!isAllowed(targetUrl)) {
    res.status(403).json({ error: '目标地址不被允许' })
    return
  }

  // 重建目标 URL：原始路径在 [...path] 参数里
  const pathSegments = req.query.path
  const pathStr = Array.isArray(pathSegments) ? pathSegments.join('/') : pathSegments || ''
  // 透传 query string
  const search = req.url?.includes('?') ? '?' + req.url.split('?')[1] : ''

  const fullUrl = `${targetUrl}/${pathStr}${search}`

  // 透传 WebDAV 认证头（Authorization）和内容类型
  const forwardHeaders: Record<string, string> = {}
  const passThrough = ['authorization', 'content-type', 'depth', 'overwrite', 'destination', 'if-match', 'if-none-match']
  for (const h of passThrough) {
    if (req.headers[h]) forwardHeaders[h] = req.headers[h]
  }

  // 读取请求体（PUT/POST 等）
  let body: Buffer | undefined
  if (['POST', 'PUT', 'PROPPATCH', 'MKCOL', 'COPY', 'MOVE'].includes(method)) {
    // Vercel node runtime：body 在 req.body 或需要读取 stream
    if (req.body) {
      body = typeof req.body === 'string' ? Buffer.from(req.body) : Buffer.from(req.body)
    }
  }

  try {
    const resp = await fetch(fullUrl, {
      method,
      headers: forwardHeaders,
      body,
    })

    // 透传状态码
    res.status(resp.status)

    // 透传关键响应头
    const respHeaders = ['content-type', 'dav', 'etag', 'last-modified', 'location', 'allow']
    for (const h of respHeaders) {
      const v = resp.headers.get(h)
      if (v) res.setHeader(h, v)
    }

    // 返回体
    const respBody = await resp.arrayBuffer()
    res.send(Buffer.from(respBody))
  } catch (e: any) {
    res.status(502).json({ error: '代理请求失败', detail: e?.message || String(e) })
  }
}

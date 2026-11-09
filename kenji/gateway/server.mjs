#!/usr/bin/env node
// Kenji Harness Gateway
// ----------------------------------------------------------------------------
// 1 プロセスで次を担当する（外部依存なし・Node 24 以上）:
//   - ハーネス本体（dsh web）を 127.0.0.1 上で子プロセスとして起動・監視する
//   - Kenji のアカウント（operator 以上）でログインさせ、HttpOnly Cookie でセッションを保つ
//   - 認証済みリクエストだけを dsh の /api と /api/remote.mux（WebSocket）へ中継する
//     （dsh の起動トークン／Cookie はサーバー側だけで保持し、ブラウザには渡さない）
//   - スマホ版 UI（kenji/mobile/dist）を配信し、従来の PC 版 UI を /full/ 配下で中継する
//
// 環境変数（すべて任意）:
//   HARNESS_ROOT   リポジトリのルート（既定: このファイルの 2 つ上）
//   GATEWAY_HOST   待ち受けアドレス（既定: 127.0.0.1）
//   GATEWAY_PORT   待ち受けポート（既定: 3090）
//   BASE_PATH      公開パス接頭辞（既定: /harness）。接頭辞なしのアクセスも受け付ける
//   KENJI_URL      Kenji API（既定: http://127.0.0.1:8787）
//   MIN_ROLE       利用に必要な Kenji ロール（viewer|operator|admin、既定: operator）
//   DSH_PORT       dsh web のポート（既定: 3080）
//   DSH_HOME       dsh のデータディレクトリ（未指定なら dsh の既定）
//   DSH_EXTRA_ARGS dsh web に追加する引数（空白区切り）
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(process.env.HARNESS_ROOT ?? path.join(here, '..', '..'))
const HOST = process.env.GATEWAY_HOST ?? '127.0.0.1'
const PORT = Number(process.env.GATEWAY_PORT ?? 3090)
const BASE = normalizeBase(process.env.BASE_PATH ?? '/harness')
const KENJI = (process.env.KENJI_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '')
const DSH_PORT = Number(process.env.DSH_PORT ?? 3080)
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 }
const MIN_ROLE = ROLE_RANK[process.env.MIN_ROLE ?? 'operator'] ?? 1
const STATIC_DIR = path.join(ROOT, 'kenji', 'mobile', 'dist')
const SESSION_COOKIE = 'kh_session'

function normalizeBase(value) {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '') return ''
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`
}

function log(...args) {
  console.log(new Date().toISOString(), '[gateway]', ...args)
}

// ---------------------------------------------------------------------------
// dsh 子プロセス
// ---------------------------------------------------------------------------
const dsh = {
  child: null,
  token: null,
  cookie: null,
  ready: false,
  restarts: 0,
  lastLines: [],
}

function dshEntry() {
  const built = path.join(ROOT, 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(built)) return [built]
  // ビルド成果物がない場合はソースから起動する（開発用）
  return ['--import', 'tsx/esm', path.join(ROOT, 'apps', 'cli', 'src', 'bin.ts')]
}

function startDsh() {
  const extra = (process.env.DSH_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean)
  const args = [...dshEntry(), 'web', '--no-open', '--host', '127.0.0.1', '--port', String(DSH_PORT), ...extra]
  log('starting dsh:', process.execPath, args.join(' '))
  dsh.ready = false
  dsh.token = null
  dsh.cookie = null
  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  dsh.child = child
  const onLine = (line) => {
    const match = /dsh web: (\S+)/.exec(line)
    const shown = line.replace(/([?&]token=)[^&\s]+/g, '$1<redacted>')
    dsh.lastLines.push(shown)
    if (dsh.lastLines.length > 200) dsh.lastLines.shift()
    console.log('[dsh]', shown)
    if (match) {
      try {
        const token = new URL(match[1]).searchParams.get('token')
        if (token) {
          dsh.token = token
          void exchangeToken()
        }
      } catch { /* 表示用 URL 以外の行は無視 */ }
    }
  }
  lineReader(child.stdout, onLine)
  lineReader(child.stderr, onLine)
  child.on('exit', (code, signal) => {
    log(`dsh exited (code=${code} signal=${signal})`)
    dsh.child = null
    dsh.ready = false
    if (shuttingDown) return
    dsh.restarts += 1
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(dsh.restarts, 5))
    setTimeout(startDsh, delay)
  })
}

function lineReader(stream, onLine) {
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      onLine(buffer.slice(0, index).replace(/\r$/, ''))
      buffer = buffer.slice(index + 1)
    }
  })
}

// 起動トークンを dsh の署名付き Cookie に交換する（Host は常に 127.0.0.1:DSH_PORT）
async function exchangeToken() {
  for (let attempt = 0; attempt < 20 && dsh.token; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${DSH_PORT}/?token=${encodeURIComponent(dsh.token)}`, { redirect: 'manual' })
      const cookies = response.headers.getSetCookie?.() ?? []
      const pairs = cookies.map(c => c.split(';')[0]).filter(c => c.startsWith('dsh-auth-'))
      if (pairs.length > 0) {
        dsh.cookie = pairs.join('; ')
        dsh.ready = true
        dsh.restarts = 0
        log('dsh is ready')
        return
      }
      log(`token exchange returned ${response.status} without a cookie; retrying`)
    } catch (error) {
      log('token exchange failed:', error.message)
    }
    await new Promise(r => setTimeout(r, 1000))
  }
}

// ---------------------------------------------------------------------------
// Kenji 認証
// ---------------------------------------------------------------------------
const authCache = new Map() // jwt -> { user, expires }

function parseCookies(header) {
  const out = {}
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

async function authenticate(req) {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
  if (!token) return null
  const cached = authCache.get(token)
  if (cached && cached.expires > Date.now()) return cached.user
  try {
    const response = await fetch(`${KENJI}/api/auth/me`, { headers: { authorization: `Bearer ${token}` } })
    if (!response.ok) {
      authCache.delete(token)
      return null
    }
    const me = await response.json()
    const user = { username: me.username, role: me.role }
    if ((ROLE_RANK[user.role] ?? -1) < MIN_ROLE) return null
    authCache.set(token, { user, expires: Date.now() + 60_000 })
    if (authCache.size > 500) authCache.delete(authCache.keys().next().value)
    return user
  } catch (error) {
    log('kenji auth check failed:', error.message)
    return null
  }
}

function isSecure(req) {
  return req.headers['x-forwarded-proto'] === 'https' || Boolean(req.socket.encrypted)
}

function sessionCookie(req, value, maxAge) {
  const attrs = [`${SESSION_COOKIE}=${encodeURIComponent(value)}`, `Path=${BASE || '/'}`, 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`]
  if (isSecure(req)) attrs.push('Secure')
  return attrs.join('; ')
}

// 状態を変えるリクエストは同一オリジンからのみ受け付ける（CSRF 対策）
// ngrok の内部エンドポイント経由では Host が書き換わることがあるため、公開オリジンは TRUSTED_ORIGINS で追加できる
const TRUSTED_ORIGINS = new Set((process.env.TRUSTED_ORIGINS ?? '').split(',').map(s => s.trim().replace(/\/+$/, '')).filter(Boolean))
function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin) return true
  if (TRUSTED_ORIGINS.has(origin)) return true
  try {
    const originHost = new URL(origin).host
    return originHost === req.headers.host || originHost === req.headers['x-forwarded-host']
  } catch {
    return false
  }
}

async function readBody(req, limit = 64 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers })
  res.end(body)
}

async function handleAuth(req, res, rel) {
  if (rel === '/auth/login' && req.method === 'POST') {
    if (!sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request refused' })
    let credentials
    try {
      credentials = JSON.parse(await readBody(req))
    } catch {
      return sendJson(res, 400, { error: 'invalid request' })
    }
    const response = await fetch(`${KENJI}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: String(credentials.username ?? ''), password: String(credentials.password ?? '') }),
    }).catch(error => ({ ok: false, status: 502, json: async () => ({ error: error.message }) }))
    const value = await response.json().catch(() => ({}))
    if (!response.ok) return sendJson(res, response.status === 429 ? 429 : 401, { error: value.error ?? 'ログインに失敗しました' })
    if ((ROLE_RANK[value.role] ?? -1) < MIN_ROLE) {
      return sendJson(res, 403, { error: 'このアカウントにはハーネスの利用権限がありません（operator 以上が必要です）' })
    }
    const maxAge = value.expires_at ? Math.max(60, Math.floor((Date.parse(value.expires_at) - Date.now()) / 1000)) : 12 * 3600
    return sendJson(res, 200, { username: value.username, role: value.role, expiresAt: value.expires_at },
      { 'set-cookie': sessionCookie(req, value.token, maxAge) })
  }
  if (rel === '/auth/logout' && req.method === 'POST') {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
    if (token) authCache.delete(token)
    return sendJson(res, 200, { ok: true }, { 'set-cookie': sessionCookie(req, '', 0) })
  }
  if (rel === '/auth/me') {
    const user = await authenticate(req)
    if (!user) return sendJson(res, 401, { error: 'unauthenticated' })
    return sendJson(res, 200, { ...user, harness: { ready: dsh.ready, restarts: dsh.restarts } })
  }
  return sendJson(res, 404, { error: 'not found' })
}

// ---------------------------------------------------------------------------
// dsh への中継
// ---------------------------------------------------------------------------
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'])
const DROP_UPSTREAM = new Set(['cookie', 'origin', 'referer', 'host', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'])

function upstreamHeaders(req) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (HOP_HEADERS.has(lower) || DROP_UPSTREAM.has(lower) || lower.startsWith('ngrok-')) continue
    headers[lower] = value
  }
  headers.host = `127.0.0.1:${DSH_PORT}`
  if (dsh.cookie) headers.cookie = dsh.cookie
  return headers
}

function proxyHttp(req, res, upstreamPath) {
  if (!dsh.ready) return sendJson(res, 503, { error: 'ハーネスを起動中です。少し待ってから再読み込みしてください。' })
  const upstream = http.request({
    host: '127.0.0.1', port: DSH_PORT, method: req.method, path: upstreamPath, headers: upstreamHeaders(req),
  }, (response) => {
    const headers = {}
    for (const [key, value] of Object.entries(response.headers)) {
      const lower = key.toLowerCase()
      if (HOP_HEADERS.has(lower) || lower === 'set-cookie') continue
      if (lower === 'location' && typeof value === 'string' && value.startsWith('/')) {
        headers[lower] = `${BASE}/full${value}`
        continue
      }
      headers[lower] = value
    }
    res.writeHead(response.statusCode ?? 502, headers)
    response.pipe(res)
  })
  upstream.on('error', (error) => {
    if (!res.headersSent) sendJson(res, 502, { error: `harness unreachable: ${error.message}` })
    else res.destroy()
  })
  req.pipe(upstream)
}

function proxyUpgrade(req, socket, head, upstreamPath) {
  const target = net.connect(DSH_PORT, '127.0.0.1', () => {
    const headers = upstreamHeaders(req)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const lines = [`GET ${upstreamPath} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`), '', '']
    target.write(lines.join('\r\n'))
    if (head?.length) target.write(head)
    target.pipe(socket)
    socket.pipe(target)
  })
  const close = () => { target.destroy(); socket.destroy() }
  target.on('error', close)
  socket.on('error', close)
}

// ---------------------------------------------------------------------------
// 静的配信（スマホ版 UI）
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}

function serveStatic(req, res, rel) {
  let file = path.normalize(path.join(STATIC_DIR, decodeURIComponent(rel)))
  if (!file.startsWith(STATIC_DIR)) return sendJson(res, 400, { error: 'bad path' })
  if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(STATIC_DIR, 'index.html')
  if (!existsSync(file)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    return res.end('スマホ版 UI がビルドされていません（kenji/mobile で npm run build を実行してください）')
  }
  const ext = path.extname(file)
  const immutable = file.includes(`${path.sep}assets${path.sep}`)
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  })
  createReadStream(file).pipe(res)
}

// ---------------------------------------------------------------------------
// ルーティング
// ---------------------------------------------------------------------------
function relativePath(url) {
  const pathname = url.split('?')[0]
  if (BASE && (pathname === BASE || pathname.startsWith(`${BASE}/`))) return { rel: pathname.slice(BASE.length) || '/', prefixed: true }
  return { rel: pathname, prefixed: false }
}

function queryOf(url) {
  const index = url.indexOf('?')
  return index < 0 ? '' : url.slice(index)
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url ?? '/'
    const { rel, prefixed } = relativePath(url)
    if (BASE && prefixed && url.split('?')[0] === BASE) {
      res.writeHead(301, { location: `${BASE}/` })
      return res.end()
    }
    if (rel === '/healthz') return sendJson(res, 200, { ok: true, harness: dsh.ready })
    if (rel.startsWith('/auth/')) return await handleAuth(req, res, rel)

    const isApi = rel === '/api' || rel.startsWith('/api/')
    const isFull = rel === '/full' || rel.startsWith('/full/')
    if (isApi || isFull) {
      const user = await authenticate(req)
      if (!user) return sendJson(res, 401, { error: 'unauthenticated' })
      if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request refused' })
      if (rel === '/full') {
        res.writeHead(301, { location: `${BASE}/full/` })
        return res.end()
      }
      const upstreamPath = isFull ? rel.slice('/full'.length) || '/' : rel
      // PC 版 UI 内の相対 API 呼び出し（/full/api/...）もそのまま /api/... へ
      return proxyHttp(req, res, upstreamPath + queryOf(url))
    }
    return serveStatic(req, res, rel === '/' ? '/index.html' : rel)
  } catch (error) {
    log('request failed:', error)
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    else res.destroy()
  }
})

server.on('upgrade', async (req, socket, head) => {
  const url = req.url ?? '/'
  const { rel } = relativePath(url)
  const target = rel.startsWith('/full/') ? rel.slice('/full'.length) : rel
  if (target !== '/api/remote.mux' || !dsh.ready) {
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n')
    return
  }
  const user = await authenticate(req)
  if (!user || !sameOrigin(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  proxyUpgrade(req, socket, head, target + queryOf(url))
})

let shuttingDown = false
function shutdown() {
  if (shuttingDown) return
  shuttingDown = true
  log('shutting down')
  server.close()
  if (dsh.child) dsh.child.kill()
  setTimeout(() => process.exit(0), 3000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}${BASE}/ (harness root: ${ROOT})`)
  startDsh()
})

#!/usr/bin/env node
// Kenji Harness Gateway
// ----------------------------------------------------------------------------
// 1 プロセスで次を担当する（外部依存なし・Node 24 以上）:
//   - ハーネス本体（dsh web）を 127.0.0.1 上で子プロセスとして起動・監視する
//   - Kenji のアカウント（operator 以上）でログインさせ、HttpOnly Cookie でセッションを保つ
//   - 認証済みリクエストだけを dsh の /api と /api/remote.mux（WebSocket）へ中継する
//     （dsh の起動トークン／Cookie はサーバー側だけで保持し、ブラウザには渡さない）
//   - 未ログインならログイン画面を返し、ログイン後は dsh の Web UI（スマホ対応）をそのまま中継する
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
//   WORKSPACE_ROOT ユーザーごとの作業フォルダの親（例: C:\ProgramData\kenji\workspace）。
//                  新しいセッションは <WORKSPACE_ROOT>\<ユーザー名> で始まる
//   EXTRA_PATH     dsh の PATH の先頭に足すディレクトリ（; 区切り）。プラグイン管理が使う pnpm / git の場所
//   PUBLIC_URL     公開 URL（例: https://example.ngrok-free.dev/harness/）。dsh が案内する Web UI の URL に使う
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs'
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
const SESSION_COOKIE = 'kh_session'
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : ''
const PUBLIC_URL = (process.env.PUBLIC_URL ?? '').trim()

/** Kenji ユーザーの作業フォルダ（Kenji 本体と同じ workspace/<ユーザー名>）。なければ作る */
function userWorkspace(username) {
  if (!WORKSPACE_ROOT || !/^[\w.@-]{1,64}$/.test(username) || username.startsWith('.')) return null
  const dir = path.join(WORKSPACE_ROOT, username)
  try {
    mkdirSync(dir, { recursive: true })
    return dir
  } catch {
    return null
  }
}

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
  const args = [...dshEntry(), 'web', '--no-open', '--host', '127.0.0.1', '--port', String(DSH_PORT),
    ...(PUBLIC_URL ? ['--public-url', PUBLIC_URL.endsWith('/') ? PUBLIC_URL : `${PUBLIC_URL}/`] : []), ...extra]
  log('starting dsh:', process.execPath, args.join(' '))
  dsh.ready = false
  dsh.token = null
  dsh.cookie = null
  // 既定の作業フォルダはハーネス本体のソースではなく、ユーザー用ワークスペースの親にする
  const cwd = WORKSPACE_ROOT && existsSync(WORKSPACE_ROOT) ? WORKSPACE_ROOT : ROOT
  const child = spawn(process.execPath, args, {
    cwd,
    env: childEnv(),
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

function childEnv() {
  const env = { ...process.env, DSH_TELEMETRY_DISABLED: '1', BROWSER: 'none', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' }
  const extra = (process.env.EXTRA_PATH ?? '').split(path.delimiter).filter(Boolean)
  if (extra.length) {
    // Windows の環境変数名は大文字小文字を区別しないため、既存のキー名に合わせる
    const key = Object.keys(env).find(k => k.toLowerCase() === 'path') ?? 'PATH'
    env[key] = [...extra, env[key] ?? ''].filter(Boolean).join(path.delimiter)
  }
  return env
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
    return sendJson(res, 200, { username: value.username, role: value.role, expiresAt: value.expires_at, workspace: userWorkspace(value.username) },
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
    return sendJson(res, 200, { ...user, workspace: userWorkspace(user.username), harness: { ready: dsh.ready, restarts: dsh.restarts } })
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
        headers[lower] = `${BASE}${value}`
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
// ログイン画面（Kenji アカウント）。認証後は dsh の Web UI をそのまま中継する
// ---------------------------------------------------------------------------
const LOGIN_HTML = `<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#181818" media="(prefers-color-scheme: dark)">
<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
<title>Harness にログイン</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP:wght@400;600&display=swap">
<style>
:root{--bg:#fff;--fg:#18181b;--muted:#71717a;--line:#e4e4e7;--card:#fff;--btn:#18181b;--btnfg:#fff;--err:#dc2626}
@media(prefers-color-scheme:dark){:root{--bg:#181818;--fg:#f2f2f2;--muted:#a8a8a8;--line:#2e2e2e;--card:#1f1f1f;--btn:#f4f4f5;--btnfg:#181818;--err:#f87171}}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 "IBM Plex Sans JP",system-ui,sans-serif;display:flex;align-items:center;justify-content:center;padding:24px}
main{width:100%;max-width:360px}h1{font-size:22px;margin:0 0 4px;font-weight:600}p{margin:0 0 24px;color:var(--muted);font-size:14px}
label{display:block;font-size:13px;color:var(--muted);margin:14px 0 6px}
input{width:100%;height:48px;border:1px solid var(--line);border-radius:12px;background:var(--card);color:var(--fg);padding:0 14px;font:inherit;font-size:16px;outline:none}
input:focus{border-color:var(--muted)}
button{margin-top:24px;width:100%;height:50px;border:0;border-radius:999px;background:var(--btn);color:var(--btnfg);font:inherit;font-size:16px;font-weight:600}
button:disabled{opacity:.5}.err{color:var(--err);font-size:14px;margin-top:14px;min-height:1.5em}
</style></head><body><main>
<h1>Harness</h1><p>Kenji のアカウントでログインしてください（operator 以上）。</p>
<form id="f"><label for="u">ユーザー名</label><input id="u" autocomplete="username" autocapitalize="none" autocorrect="off" required>
<label for="pw">パスワード</label><input id="pw" type="password" autocomplete="current-password" required>
<button id="b" type="submit">ログイン</button><div class="err" id="e" role="alert"></div></form>
<script>
const f=document.getElementById('f'),b=document.getElementById('b'),e=document.getElementById('e'),u=document.getElementById('u')
try{u.value=localStorage.getItem('kh.lastUser')||''}catch{}
f.addEventListener('submit',async ev=>{ev.preventDefault();b.disabled=true;e.textContent=''
try{const r=await fetch('auth/login',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({username:u.value.trim(),password:document.getElementById('pw').value})})
const v=await r.json().catch(()=>({}));if(!r.ok)throw new Error(v.error||'ログインできませんでした')
try{localStorage.setItem('kh.lastUser',u.value.trim())}catch{}
const next=new URLSearchParams(location.search).get('next');location.replace(next&&next.startsWith('./')?next:'./')}
catch(x){e.textContent=x.message;b.disabled=false}})
</script></main></body></html>`

// Android アプリの更新配信（APK は公開して問題ない成果物なのでログイン不要）
const APP_DIR = path.join(ROOT, 'kenji', 'android', 'dist')
function serveApp(res, name) {
  const file = path.join(APP_DIR, name)
  if (!existsSync(file)) return sendJson(res, 404, { error: 'not found' })
  const type = name.endsWith('.apk') ? 'application/vnd.android.package-archive' : 'application/json; charset=utf-8'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache', 'content-length': statSync(file).size })
  createReadStream(file).pipe(res)
}

function sendLogin(res) {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(LOGIN_HTML)
}

function wantsHtml(req) {
  return req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')
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

/** 旧スマホ版の /full/ 配下へのリンクは dsh 本体（ルート）に寄せる */
function stripFull(rel) {
  return rel === '/full' || rel.startsWith('/full/') ? rel.slice('/full'.length) || '/' : rel
}

const server = http.createServer(async (req, res) => {
  try {
    const url = req.url ?? '/'
    const { rel: rawRel, prefixed } = relativePath(url)
    if (BASE && prefixed && url.split('?')[0] === BASE) {
      res.writeHead(301, { location: `${BASE}/` })
      return res.end()
    }
    if (rawRel === '/full' || rawRel.startsWith('/full/')) {
      res.writeHead(301, { location: `${BASE}${stripFull(rawRel)}${queryOf(url)}` })
      return res.end()
    }
    const rel = rawRel
    if (rel === '/healthz') return sendJson(res, 200, { ok: true, harness: dsh.ready })
    if (rel === '/app/version.json' || rel === '/app/kenji-harness.apk') return serveApp(res, rel.slice('/app/'.length))
    if (rel === '/login') return sendLogin(res)
    if (rel === '/logout') {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
      if (token) authCache.delete(token)
      res.writeHead(302, { location: `${BASE}/login`, 'set-cookie': sessionCookie(req, '', 0) })
      return res.end()
    }
    if (rel.startsWith('/auth/')) return await handleAuth(req, res, rel)

    const user = await authenticate(req)
    if (!user) {
      if (wantsHtml(req)) {
        const next = `.${rel}${queryOf(url)}`
        res.writeHead(302, { location: `${BASE}/login${rel === '/' ? '' : `?next=${encodeURIComponent(next)}`}`, 'cache-control': 'no-store' })
        return res.end()
      }
      return sendJson(res, 401, { error: 'unauthenticated' })
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) return sendJson(res, 403, { error: 'cross-origin request refused' })
    return proxyHttp(req, res, rel + queryOf(url))
  } catch (error) {
    log('request failed:', error)
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    else res.destroy()
  }
})

server.on('upgrade', async (req, socket, head) => {
  const url = req.url ?? '/'
  const target = stripFull(relativePath(url).rel)
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
function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (exit ${exitCode})`)
  server.close()
  if (dsh.child) dsh.child.kill()
  setTimeout(() => process.exit(exitCode), 3000).unref()
}

// ---------------------------------------------------------------------------
// 自動更新: ビルドスクリプトが restart-request を更新したら、実行中のセッションが
// なくなるのを待ってから終了コード 75 で終わる（Kenji のジョブが on_failure で再起動する）
// ---------------------------------------------------------------------------
const RESTART_FILE = process.env.RESTART_REQUEST ?? path.join(path.dirname(ROOT), 'restart-request')
const RESTART_EXIT_CODE = 75
const RESTART_MAX_WAIT_MS = 2 * 60 * 60 * 1000

function restartStamp() {
  try { return statSync(RESTART_FILE).mtimeMs } catch { return 0 }
}

async function anySessionRunning() {
  if (!dsh.ready) return false
  try {
    const response = await fetch(`http://127.0.0.1:${DSH_PORT}/api/session/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: dsh.cookie ?? '' },
      body: JSON.stringify({ type: 'client-request', rpcId: `restart-${Date.now()}`, method: 'session/list', payload: { args: { _request: {} } } }),
    })
    const body = await response.json()
    return Boolean(body?.result?.value?.items?.some(item => item.running))
  } catch (error) {
    log('could not read session state before restart:', error.message)
    return false
  }
}

const startStamp = restartStamp()
let restartSince = 0
setInterval(async () => {
  if (shuttingDown || restartStamp() <= startStamp) return
  if (!restartSince) {
    restartSince = Date.now()
    log('update installed; restarting once no session is running')
  }
  if (await anySessionRunning() && Date.now() - restartSince < RESTART_MAX_WAIT_MS) return
  shutdown(RESTART_EXIT_CODE)
}, 20_000).unref()
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}${BASE}/ (harness root: ${ROOT})`)
  startDsh()
})

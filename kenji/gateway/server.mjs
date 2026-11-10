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
//   DSH_PORT       ユーザー別 dsh web に割り当てるポートの開始値（既定: 3080。使用中なら空きポートへ）
//   DSH_HOME       旧・共有データディレクトリ。LEGACY_HOME_OWNER のユーザーへ 1 回だけ移す（移行用）
//   LEGACY_HOME_OWNER 旧共有データの持ち主（既定: admin）
//   IDLE_MINUTES   実行中セッションのないユーザー別 dsh を止めるまでの無操作時間（既定: 30。0 で止めない）
//   DSH_EXTRA_ARGS dsh web に追加する引数（空白区切り）
//   WORKSPACE_ROOT ユーザーごとのルートフォルダの親（例: C:\ProgramData\kenji\workspace）。
//                  <WORKSPACE_ROOT>\<ユーザー名> がそのユーザーのホーム兼ルートで、
//                  設定・認証情報・セッション・プラグインは <ルート>\.dsh に完全に分かれて入る
//   EXTRA_PATH     dsh の PATH の先頭に足すディレクトリ（; 区切り）。プラグイン管理が使う pnpm / git の場所
//   PUBLIC_URL     公開 URL（例: https://example.ngrok-free.dev/harness/）。dsh が案内する Web UI の URL に使う
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
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
const DSH_PORT_BASE = Number(process.env.DSH_PORT ?? 3080)
const IDLE_MS = Number(process.env.IDLE_MINUTES ?? 30) * 60_000
const LEGACY_HOME = process.env.DSH_HOME ? path.resolve(process.env.DSH_HOME) : ''
const LEGACY_OWNER = (process.env.LEGACY_HOME_OWNER ?? 'admin').toLowerCase()
const ROLE_RANK = { viewer: 0, operator: 1, admin: 2 }
const MIN_ROLE = ROLE_RANK[process.env.MIN_ROLE ?? 'operator'] ?? 1
const SESSION_COOKIE = 'kh_session'
const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ? path.resolve(process.env.WORKSPACE_ROOT) : ''
const PUBLIC_URL = (process.env.PUBLIC_URL ?? '').trim()

const RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i
function safeUserName(username) {
  return /^[\w.@-]{1,64}$/.test(username) && !username.startsWith('.') && !username.endsWith('.') && !RESERVED_NAMES.test(username)
}

/** Kenji ユーザーのホーム兼ルートフォルダ（Kenji 本体と同じ workspace/<ユーザー名>）。なければ作る */
function userWorkspace(username) {
  if (!WORKSPACE_ROOT || !safeUserName(username)) return null
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
// dsh 子プロセス（Kenji ユーザーごとに 1 つ）
// ---------------------------------------------------------------------------
// ユーザーのルートフォルダを HOME / USERPROFILE / APPDATA にし、dsh の設定・認証情報・
// セッション・プラグインは <ルート>\.dsh に置く。ユーザー間でデータも認証情報も共有しない。
const instances = new Map() // 小文字のユーザー名 -> instance

function dshEntry() {
  const built = path.join(ROOT, 'apps', 'cli', 'lib', 'bin.js')
  if (existsSync(built)) return [built]
  // ビルド成果物がない場合はソースから起動する（開発用）
  return ['--import', 'tsx/esm', path.join(ROOT, 'apps', 'cli', 'src', 'bin.ts')]
}

function freePort(preferred) {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', () => {
      const any = net.createServer()
      any.once('error', reject)
      any.listen(0, '127.0.0.1', () => { const { port } = any.address(); any.close(() => resolve(port)) })
    })
    probe.listen(preferred, '127.0.0.1', () => probe.close(() => resolve(preferred)))
  })
}

/** 旧・共有データ（DSH_HOME）を持ち主のホームへ 1 回だけ移す。他のユーザーには引き継がない */
function migrateLegacyHome(username, dshHome) {
  if (!LEGACY_HOME || username.toLowerCase() !== LEGACY_OWNER || existsSync(dshHome) || !existsSync(LEGACY_HOME)) return
  try {
    renameSync(LEGACY_HOME, dshHome)
    log(`moved the shared harness data ${LEGACY_HOME} -> ${dshHome}`)
  } catch (error) {
    log(`could not move the shared harness data (${error.message}); ${username} starts with an empty home`)
  }
}

async function getInstance(user) {
  const key = user.username.toLowerCase()
  let inst = instances.get(key)
  if (!inst) {
    const rootDir = userWorkspace(user.username)
    if (!rootDir) return null
    const dshHome = path.join(rootDir, '.dsh')
    migrateLegacyHome(user.username, dshHome)
    inst = {
      username: user.username, rootDir, dshHome, port: 0, child: null, token: null, cookie: null,
      ready: false, restarts: 0, lastLines: [], lastActive: Date.now(), stopped: false, starting: null, sockets: 0,
    }
    instances.set(key, inst)
  }
  inst.lastActive = Date.now()
  if (!inst.child && !inst.starting && !shuttingDown && Date.now() >= (inst.nextStartAt ?? 0)) inst.starting = startDsh(inst).finally(() => { inst.starting = null })
  return inst
}

async function startDsh(inst) {
  inst.stopped = false
  inst.port = await freePort(inst.port || DSH_PORT_BASE + instances.size)
  const extra = (process.env.DSH_EXTRA_ARGS ?? '').split(/\s+/).filter(Boolean)
  const args = [...dshEntry(), 'web', '--no-open', '--host', '127.0.0.1', '--port', String(inst.port),
    ...(PUBLIC_URL ? ['--public-url', PUBLIC_URL.endsWith('/') ? PUBLIC_URL : `${PUBLIC_URL}/`] : []), ...extra]
  log(`starting dsh for ${inst.username} on :${inst.port}`)
  inst.ready = false
  inst.token = null
  inst.cookie = null
  mkdirSync(inst.dshHome, { recursive: true })
  const child = spawn(process.execPath, args, {
    cwd: inst.rootDir,
    env: childEnv(inst),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  inst.child = child
  const onLine = (line) => {
    const match = /dsh web: (\S+)/.exec(line)
    const shown = line.replace(/([?&]token=)[^&\s]+/g, '$1<redacted>')
    inst.lastLines.push(shown)
    if (inst.lastLines.length > 200) inst.lastLines.shift()
    console.log(`[dsh:${inst.username}]`, shown)
    if (match) {
      try {
        const token = new URL(match[1]).searchParams.get('token')
        if (token) {
          inst.token = token
          void exchangeToken(inst)
        }
      } catch { /* 表示用 URL 以外の行は無視 */ }
    }
  }
  lineReader(child.stdout, onLine)
  lineReader(child.stderr, onLine)
  child.on('exit', (code, signal) => {
    log(`dsh for ${inst.username} exited (code=${code} signal=${signal})`)
    inst.child = null
    inst.ready = false
    if (shuttingDown || inst.stopped) return
    inst.restarts += 1
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(inst.restarts, 5))
    inst.nextStartAt = Date.now() + delay
    setTimeout(() => { if (!inst.child && !inst.starting && !shuttingDown && !inst.stopped) inst.starting = startDsh(inst).finally(() => { inst.starting = null }) }, delay)
  })
}

// 認証情報になりうる環境変数は子プロセスへ渡さない（ゲートウェイ自身の環境に紛れ込んでいても漏らさない）
const SECRET_ENV = /(token|secret|password|passwd|api[_-]?key|credential|private[_-]?key)/i

function childEnv(inst) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (SECRET_ENV.test(key) || key === 'DSH_HOME') continue
    env[key] = value
  }
  const home = inst.rootDir
  const local = path.join(home, 'AppData', 'Local')
  const roaming = path.join(home, 'AppData', 'Roaming')
  const temp = path.join(home, '.tmp')
  for (const dir of [local, roaming, temp]) mkdirSync(dir, { recursive: true })
  Object.assign(env, {
    DSH_HOME: inst.dshHome, HOME: home, USERPROFILE: home, APPDATA: roaming, LOCALAPPDATA: local,
    XDG_CONFIG_HOME: roaming, XDG_DATA_HOME: local, XDG_CACHE_HOME: path.join(local, 'cache'),
    TEMP: temp, TMP: temp, TMPDIR: temp,
    DSH_TELEMETRY_DISABLED: '1', BROWSER: 'none', COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
  })
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

// 起動トークンを dsh の署名付き Cookie に交換する（Host は常に 127.0.0.1:そのユーザーのポート）
async function exchangeToken(inst) {
  for (let attempt = 0; attempt < 20 && inst.token; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${inst.port}/?token=${encodeURIComponent(inst.token)}`, { redirect: 'manual' })
      const cookies = response.headers.getSetCookie?.() ?? []
      const pairs = cookies.map(c => c.split(';')[0]).filter(c => c.startsWith('dsh-auth-'))
      if (pairs.length > 0) {
        inst.cookie = pairs.join('; ')
        inst.ready = true
        inst.restarts = 0
        log(`dsh for ${inst.username} is ready`)
        return
      }
      log(`token exchange for ${inst.username} returned ${response.status} without a cookie; retrying`)
    } catch (error) {
      log(`token exchange for ${inst.username} failed:`, error.message)
    }
    await new Promise(r => setTimeout(r, 1000))
  }
}

/** Windows は親を止めても子が残るため、dsh とその子プロセスをまとめて終了する */
function killTree(child) {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill())
  } else {
    child.kill()
  }
}

/** dsh の再起動直後に届いた再接続は、準備ができるまで少し待ってから中継する */
async function waitReady(inst, ms) {
  const until = Date.now() + ms
  while (!inst.ready && Date.now() < until && !shuttingDown) {
    if (!inst.child && !inst.starting && Date.now() >= (inst.nextStartAt ?? 0)) inst.starting = startDsh(inst).finally(() => { inst.starting = null })
    await new Promise(r => setTimeout(r, 500))
  }
  return inst.ready
}

function stopInstance(inst) {
  inst.stopped = true
  inst.ready = false
  killTree(inst.child)
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
    void getInstance({ username: value.username }).catch(error => log('could not start the harness for the user:', error.message))
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
    const inst = await getInstance(user)
    return sendJson(res, 200, { ...user, workspace: userWorkspace(user.username), harness: { ready: Boolean(inst?.ready), restarts: inst?.restarts ?? 0 } })
  }
  return sendJson(res, 404, { error: 'not found' })
}

// ---------------------------------------------------------------------------
// dsh への中継
// ---------------------------------------------------------------------------
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer'])
const DROP_UPSTREAM = new Set(['cookie', 'origin', 'referer', 'host', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'forwarded'])

function upstreamHeaders(req, inst) {
  const headers = {}
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase()
    if (HOP_HEADERS.has(lower) || DROP_UPSTREAM.has(lower) || lower.startsWith('ngrok-')) continue
    headers[lower] = value
  }
  headers.host = `127.0.0.1:${inst.port}`
  if (inst.cookie) headers.cookie = inst.cookie
  return headers
}

const PUBLIC_STATIC = new Set(['/manifest.webmanifest', '/apple-touch-icon.png', '/favicon.svg', '/favicon-dark.svg'])

const STARTING_HTML = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="3"><title>起動中</title>
<style>body{margin:0;height:100vh;display:flex;align-items:center;justify-content:center;background:#181818;color:#f2f2f2;font:15px "IBM Plex Sans JP",system-ui,sans-serif}</style>
<body>ハーネスを起動しています…（数秒で自動的に開きます）</body></html>`

function proxyHttp(req, res, upstreamPath, inst) {
  if (!inst?.ready) {
    if (wantsHtml(req)) {
      res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '3' })
      return res.end(STARTING_HTML)
    }
    return sendJson(res, 503, { error: 'ハーネスを起動中です。少し待ってから再読み込みしてください。' })
  }
  const upstream = http.request({
    host: '127.0.0.1', port: inst.port, method: req.method, path: upstreamPath, headers: upstreamHeaders(req, inst),
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

function proxyUpgrade(req, socket, head, upstreamPath, inst) {
  inst.sockets += 1
  let counted = true
  const release = () => { if (counted) { counted = false; inst.sockets -= 1; inst.lastActive = Date.now() } }
  const target = net.connect(inst.port, '127.0.0.1', () => {
    const headers = upstreamHeaders(req, inst)
    headers.connection = 'Upgrade'
    headers.upgrade = req.headers.upgrade ?? 'websocket'
    const lines = [`GET ${upstreamPath} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`), '', '']
    target.write(lines.join('\r\n'))
    if (head?.length) target.write(head)
    target.pipe(socket)
    socket.pipe(target)
  })
  const close = () => { release(); target.destroy(); socket.destroy() }
  target.on('error', close)
  socket.on('error', close)
  target.on('close', close)
  socket.on('close', close)
  // 通信があるあいだは「操作中」とみなす（画面を開いたまま放置しても止めない）
  socket.on('data', () => { inst.lastActive = Date.now() })
  target.on('data', () => { inst.lastActive = Date.now() })
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
    // `/harness*` はトンネルのパス指定をそのまま URL に写した入力。ログイン後に /harness/harness* へ飛ばないよう /harness/ に寄せる
    if (BASE && (url.split('?')[0] === BASE || url.split('?')[0] === `${BASE}*`)) {
      res.writeHead(301, { location: `${BASE}/` })
      return res.end()
    }
    if (rawRel === '/full' || rawRel.startsWith('/full/')) {
      res.writeHead(301, { location: `${BASE}${stripFull(rawRel)}${queryOf(url)}` })
      return res.end()
    }
    const rel = rawRel
    if (rel === '/healthz') return sendJson(res, 200, { ok: true, harness: [...instances.values()].some(i => i.ready), users: instances.size })
    if (rel === '/app/version.json' || rel === '/app/kenji-harness.apk') return serveApp(res, rel.slice('/app/'.length))
    if (rel === '/login') return sendLogin(res)
    if (rel === '/logout') {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE]
      if (token) authCache.delete(token)
      res.writeHead(302, { location: `${BASE}/login`, 'set-cookie': sessionCookie(req, '', 0) })
      return res.end()
    }
    if (rel.startsWith('/auth/')) return await handleAuth(req, res, rel)

    // マニフェストとアイコンはブラウザが Cookie なしで取りに来る。中身はユーザーに依らない静的ファイルなので、準備済みのどの dsh からでも返す
    if (PUBLIC_STATIC.has(rel) && (req.method === 'GET' || req.method === 'HEAD')) {
      const any = [...instances.values()].find(i => i.ready)
      if (any) return proxyHttp(req, res, rel + queryOf(url), any)
    }
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
    const inst = await getInstance(user)
    if (!inst) return sendJson(res, 403, { error: 'このユーザー名ではハーネスを使えません' })
    return proxyHttp(req, res, rel + queryOf(url), inst)
  } catch (error) {
    log('request failed:', error)
    if (!res.headersSent) sendJson(res, 500, { error: 'internal error' })
    else res.destroy()
  }
})

server.on('upgrade', async (req, socket, head) => {
  const url = req.url ?? '/'
  const target = stripFull(relativePath(url).rel)
  const user = await authenticate(req)
  if (!user || !sameOrigin(req)) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  const inst = await getInstance(user)
  if (!inst || !(await waitReady(inst, 30_000))) {
    socket.end('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 3\r\n\r\n')
    return
  }
  proxyUpgrade(req, socket, head, target + queryOf(url), inst)
})

let shuttingDown = false
function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down (exit ${exitCode})`)
  // The process may end on its own once the server and child are gone; exitCode keeps the
  // status (75 = restart for an update) even when the timer below never fires.
  process.exitCode = exitCode
  server.close()
  for (const inst of instances.values()) stopInstance(inst)
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

async function sessionRunning(inst) {
  if (!inst.ready) return false
  try {
    const response = await fetch(`http://127.0.0.1:${inst.port}/api/session/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: inst.cookie ?? '' },
      body: JSON.stringify({ type: 'client-request', rpcId: `restart-${Date.now()}`, method: 'session/list', payload: { args: { _request: {} } } }),
    })
    const body = await response.json()
    return Boolean(body?.result?.value?.items?.some(item => item.running))
  } catch (error) {
    log(`could not read the session state of ${inst.username}:`, error.message)
    return false
  }
}

async function anySessionRunning() {
  for (const inst of instances.values()) if (await sessionRunning(inst)) return true
  return false
}

// 実行中のセッションがなく、しばらく操作もないユーザーの dsh は止めてメモリを空ける（次のアクセスで起動し直す）
if (IDLE_MS > 0) {
  setInterval(async () => {
    for (const inst of instances.values()) {
      if (!inst.child || inst.sockets > 0 || Date.now() - inst.lastActive < IDLE_MS) continue
      if (await sessionRunning(inst)) { inst.lastActive = Date.now(); continue }
      log(`stopping the idle harness of ${inst.username}`)
      stopInstance(inst)
    }
  }, 60_000).unref()
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
  log(`listening on http://${HOST}:${PORT}${BASE}/ (harness root: ${ROOT}, user homes: ${WORKSPACE_ROOT || '(none)'})`)
})

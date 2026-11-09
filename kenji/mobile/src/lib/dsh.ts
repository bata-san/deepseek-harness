// ハーネス（dsh）の Typert Remote プロトコルを直接話す小さなクライアント。
//   単発呼び出し: POST api/<namespace>/<method>
//     { type:'client-request', rpcId, method:'<ns>/<method>', payload:{ args } }
//     → { type:'server-response', rpcId, result:{ ok, value } | { ok:false, error } }
//   ストリーム:   WebSocket api/remote.mux（open / item / end / cancel を多重化）
//   ホスト→クライアントのイベント: 内部ストリーム "$events"（承認などの waterfall を含む）

export class RemoteError extends Error {
  constructor(message: string, readonly code?: string, readonly details?: unknown) {
    super(message)
    this.name = 'RemoteError'
  }
}

export class UnauthorizedError extends Error {
  constructor() {
    super('ログインが必要です')
    this.name = 'UnauthorizedError'
  }
}

function errorFrom(value: unknown, fallback: string): RemoteError {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    const message = typeof record.message === 'string' ? record.message : fallback
    return new RemoteError(message, typeof record.code === 'string' ? record.code : undefined, record.details)
  }
  return new RemoteError(typeof value === 'string' ? value : fallback)
}

/** 単発の Remote 呼び出し。args のキーはホスト側メソッドの引数名。 */
export async function call<T = unknown>(endpoint: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
  const rpcId = newId()
  const response = await fetch(`api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    credentials: 'same-origin',
    signal,
  })
  if (response.status === 401) {
    window.dispatchEvent(new Event('kh:unauthorized'))
    throw new UnauthorizedError()
  }
  const text = await response.text()
  let envelope: unknown
  try {
    envelope = JSON.parse(text)
  } catch {
    throw new RemoteError(text.slice(0, 300) || `HTTP ${response.status}`)
  }
  const result = (envelope as { result?: { ok?: boolean; value?: unknown; error?: unknown } })?.result
  if (result?.ok === true) return result.value as T
  if (result?.ok === false) throw errorFrom(result.error, `${endpoint} に失敗しました`)
  throw errorFrom((envelope as { error?: unknown })?.error ?? envelope, `HTTP ${response.status}`)
}

type StreamHandlers = {
  onItem: (value: unknown) => void
  onError?: (error: RemoteError) => void
  onEnd?: () => void
}

type ServerMessage =
  | { type: 'item'; streamId: string; value?: unknown }
  | { type: 'error'; streamId: string; error: { code: string; message: string; details: object } }
  | { type: 'end'; streamId: string }

export type ConnectionState = 'connecting' | 'open' | 'closed'

/** 1 本の WebSocket に複数ストリームを載せる。切断時は自動で再接続し、開いていたストリームを開き直す。 */
export class Mux {
  private socket: WebSocket | null = null
  private streams = new Map<string, { endpoint: string; args: Record<string, unknown>; handlers: StreamHandlers }>()
  private seq = 0
  private retry = 0
  private closedByUser = false
  private listeners = new Set<(state: ConnectionState) => void>()
  state: ConnectionState = 'closed'

  connect(): void {
    this.closedByUser = false
    this.open()
  }

  close(): void {
    this.closedByUser = true
    this.socket?.close()
  }

  onState(listener: (state: ConnectionState) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private setState(state: ConnectionState) {
    this.state = state
    for (const listener of this.listeners) listener(state)
  }

  private open() {
    const url = new URL('api/remote.mux', window.location.href)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    this.setState('connecting')
    const socket = new WebSocket(url)
    this.socket = socket
    socket.onopen = () => {
      this.retry = 0
      this.setState('open')
      for (const [streamId, stream] of this.streams) this.sendOpen(streamId, stream.endpoint, stream.args)
    }
    socket.onmessage = (event) => {
      let message: ServerMessage
      try {
        message = JSON.parse(String(event.data)) as ServerMessage
      } catch {
        return
      }
      const stream = this.streams.get(message.streamId)
      if (!stream) return
      if (message.type === 'item') stream.handlers.onItem(message.value)
      else if (message.type === 'error') {
        this.streams.delete(message.streamId)
        stream.handlers.onError?.(new RemoteError(message.error.message, message.error.code, message.error.details))
      } else if (message.type === 'end') {
        this.streams.delete(message.streamId)
        stream.handlers.onEnd?.()
      }
    }
    socket.onclose = () => {
      if (this.socket !== socket) return
      this.socket = null
      this.setState('closed')
      if (this.closedByUser) return
      const delay = Math.min(15000, 500 * 2 ** this.retry++)
      window.setTimeout(() => {
        if (!this.closedByUser) this.open()
      }, delay)
    }
  }

  private sendOpen(streamId: string, endpoint: string, args: Record<string, unknown>) {
    this.socket?.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
  }

  /** ストリームを開く。戻り値を呼ぶと閉じる。 */
  stream(endpoint: string, args: Record<string, unknown>, handlers: StreamHandlers): () => void {
    const streamId = `s${Date.now().toString(36)}-${++this.seq}`
    this.streams.set(streamId, { endpoint, args, handlers })
    if (this.socket?.readyState === WebSocket.OPEN) this.sendOpen(streamId, endpoint, args)
    return () => {
      if (!this.streams.delete(streamId)) return
      if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', streamId }))
    }
  }
}

export const mux = new Mux()

// ---------------------------------------------------------------------------
// ホスト→クライアントのイベント（承認・質問など）
// ---------------------------------------------------------------------------
export type WaterfallFrame = {
  type: 'waterfall'
  event: string
  eventId: string
  agentId: string
  request: Record<string, unknown>
}

type EventFrame =
  | { type: 'ready'; clientId: string; host: { home: string } }
  | { type: 'emit'; event: string; args: unknown[] }
  | WaterfallFrame
  | { type: 'cancel'; eventId: string }

export type PendingWaterfall = WaterfallFrame & { clientId: string; receivedAt: number }

type EventsListener = {
  onWaterfall: (pending: PendingWaterfall) => void
  onCancel: (eventId: string) => void
  onEmit?: (event: string, args: unknown[]) => void
  onReady?: (home: string) => void
}

/** "$events" を購読する。承認待ちなどの waterfall を受け取り、answer で応答する。 */
export function subscribeEvents(listener: EventsListener): () => void {
  let clientId = ''
  return mux.stream('$events', {}, {
    onItem: (value) => {
      const frame = value as EventFrame
      if (frame.type === 'ready') {
        clientId = frame.clientId
        listener.onReady?.(frame.host?.home ?? '')
      } else if (frame.type === 'waterfall') {
        listener.onWaterfall({ ...frame, clientId, receivedAt: Date.now() })
      } else if (frame.type === 'cancel') {
        listener.onCancel(frame.eventId)
      } else if (frame.type === 'emit') {
        listener.onEmit?.(frame.event, frame.args)
      }
    },
  })
}

export type WaterfallOutcome = { kind: 'next' } | { kind: 'result'; value?: unknown } | { kind: 'rejected'; error: { name: string; message: string } }

export function answerWaterfall(pending: PendingWaterfall, outcome: WaterfallOutcome): Promise<unknown> {
  return call('$events/result', { clientId: pending.clientId, eventId: pending.eventId, outcome })
}

// ---------------------------------------------------------------------------
// ゲートウェイ（Kenji 認証）
// ---------------------------------------------------------------------------
export type Me = { username: string; role: string; workspace?: string | null; harness?: { ready: boolean; restarts: number } }

export async function fetchMe(): Promise<Me | null> {
  const response = await fetch('auth/me', { credentials: 'same-origin' })
  if (response.status === 401) return null
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json() as Promise<Me>
}

export async function login(username: string, password: string): Promise<Me> {
  const response = await fetch('auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    credentials: 'same-origin',
  })
  const value = await response.json().catch(() => ({})) as { error?: string } & Me
  if (!response.ok) throw new Error(value.error ?? 'ログインに失敗しました')
  return value
}

export async function logout(): Promise<void> {
  await fetch('auth/logout', { method: 'POST', credentials: 'same-origin' })
}

/** UUID v4（randomUUID が使えない非セキュア環境でも動くように自前で組み立てる） */
export function newId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  const b = crypto.getRandomValues(new Uint8Array(16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

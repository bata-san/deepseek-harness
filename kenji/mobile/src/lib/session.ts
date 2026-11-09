// セッションの会話ストリーム（session/follow）を、画面に出しやすい形へ組み立てる。
import { useEffect, useMemo, useReducer, useRef } from 'react'
import { mux, type RemoteError } from './dsh'

type Json = unknown
export type WireEvent = { type: string; seq: number; time: number; data: Json; surfaceOp?: Json }

export type TextPart = { kind: 'text'; text: string }
export type ReasoningPart = { kind: 'reasoning'; text: string }
export type ToolPart = {
  kind: 'tool'
  callId: string
  name: string
  args: string
  result?: { text: string; isError: boolean }
}
export type AssistantPart = TextPart | ReasoningPart | ToolPart

export type ChatItem =
  | { kind: 'user'; key: string; time: number; text: string; images: number }
  | { kind: 'assistant'; key: string; time: number; parts: AssistantPart[]; interrupted?: boolean; model?: string; live?: boolean }
  | { kind: 'error'; key: string; time: number; message: string; code?: string }
  | { kind: 'notice'; key: string; time: number; text: string }

type LiveBlock = { type: string; text: string; id?: string; name?: string }
type LiveAttempt = { attemptId: string; blocks: LiveBlock[] }

type State = {
  events: WireEvent[]
  seen: Set<number>
  hasMore: boolean
  title: string | null
  cwd?: string
  live: LiveAttempt | null
  running: boolean
  loaded: boolean
  error: string | null
  modelSelection?: { provider: string; model: string; reasoningEffort?: string } | null
  projections: Record<string, unknown>
}

type Action =
  | { type: 'reset' }
  | { type: 'snapshot'; frame: SnapshotFrame }
  | { type: 'event'; event: WireEvent }
  | { type: 'stream'; frame: StreamFrame }
  | { type: 'error'; message: string }
  | { type: 'projections'; changes: { key: string; val: unknown }[] }

type SnapshotFrame = {
  type: 'snapshot'
  header: { cwd?: string }
  records: { type: 'event'; event: WireEvent }[]
  hasMore: boolean
  projections?: { values?: Record<string, unknown> }
}
type StreamFrame =
  | { type: 'start'; attemptId: string }
  | { type: 'chunk'; attemptId: string; chunk: Record<string, unknown> }
  | { type: 'end'; attemptId: string }

const initial: State = { events: [], seen: new Set(), hasMore: false, title: null, live: null, running: false, loaded: false, error: null, projections: {} }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function runningFrom(events: WireEvent[]): boolean {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const type = events[i].type
    if (type === 'turn/end') return false
    if (type === 'turn/start') return true
  }
  return false
}

function applyEvent(state: State, event: WireEvent): State {
  if (state.seen.has(event.seq)) return state
  const seen = new Set(state.seen)
  seen.add(event.seq)
  const events = [...state.events, event]
  let { title, running } = state
  if (event.type === 'session/title' && isRecord(event.data) && typeof event.data.title === 'string') title = event.data.title
  if (event.type === 'turn/start') running = true
  if (event.type === 'turn/end') running = false
  const live = event.type === 'assistant/message' || event.type === 'assistant/attempt' || event.type === 'turn/end' ? null : state.live
  return { ...state, events, seen, title, running, live }
}

function applyChunk(live: LiveAttempt, chunk: Record<string, unknown>): LiveAttempt {
  const blocks = [...live.blocks]
  const index = typeof chunk.index === 'number' ? chunk.index : blocks.length
  const ensure = (type: string) => {
    if (!blocks[index]) blocks[index] = { type, text: '' }
    return blocks[index]
  }
  switch (chunk.type) {
    case 'block-start':
      blocks[index] = { type: String(chunk.blockType ?? 'text'), text: '' }
      break
    case 'text-delta': {
      const block = ensure('text')
      blocks[index] = { ...block, text: block.text + String(chunk.text ?? '') }
      break
    }
    case 'reasoning-delta': {
      const block = ensure('reasoning')
      blocks[index] = { ...block, text: block.text + String(chunk.text ?? '') }
      break
    }
    case 'tool-call-delta': {
      const block = ensure('tool-call')
      blocks[index] = { ...block, id: String(chunk.id ?? block.id ?? ''), name: typeof chunk.name === 'string' ? chunk.name : block.name, text: block.text + String(chunk.argumentsDelta ?? '') }
      break
    }
    default:
      break
  }
  return { ...live, blocks }
}

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'reset':
      return initial
    case 'snapshot': {
      let next: State = { ...initial, loaded: true, hasMore: action.frame.hasMore, cwd: action.frame.header?.cwd }
      const values = action.frame.projections?.values ?? {}
      if (typeof values.title === 'string') next.title = values.title
      next.projections = { ...values }
      next.modelSelection = selectionOf(values.modelSelection)
      for (const record of action.frame.records ?? []) if (record?.event) next = applyEvent(next, record.event)
      next.running = runningFrom(next.events)
      return next
    }
    case 'event':
      return applyEvent(state, action.event)
    case 'stream': {
      const frame = action.frame
      if (frame.type === 'start') return { ...state, live: { attemptId: frame.attemptId, blocks: [] } }
      if (frame.type === 'chunk') {
        const live = state.live && state.live.attemptId === frame.attemptId ? state.live : { attemptId: frame.attemptId, blocks: [] }
        return { ...state, live: applyChunk(live, frame.chunk ?? {}) }
      }
      if (frame.type === 'end') return state.live?.attemptId === frame.attemptId ? { ...state, live: null } : state
      return state
    }
    case 'error':
      return { ...state, error: action.message, loaded: true }
    case 'projections': {
      const projections = { ...state.projections }
      for (const change of action.changes) projections[change.key] = change.val
      const title = typeof projections.title === 'string' ? projections.title : state.title
      return { ...state, projections, title, modelSelection: selectionOf(projections.modelSelection) ?? state.modelSelection }
    }
    default:
      return state
  }
}

function selectionOf(value: unknown): State['modelSelection'] {
  if (!isRecord(value)) return null
  const selection = value.next ?? value.lastUsed
  if (!isRecord(selection) || typeof selection.provider !== 'string' || typeof selection.model !== 'string') return null
  return {
    provider: selection.provider,
    model: selection.model,
    ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}),
  }
}

/** コンテキストの使用状況（直近リクエストのトークン数とモデルのコンテキストウィンドウ） */
export function contextUsage(projections: Record<string, unknown>): { used: number; window: number } | null {
  const pressure = projections.contextPressure
  if (!isRecord(pressure)) return null
  const used = typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens : typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens : 0
  const window = typeof pressure.contextWindow === 'number' ? pressure.contextWindow : 0
  return window > 0 ? { used, window } : null
}

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.map(part => (isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')).filter(Boolean).join('\n')
}

function countImages(content: unknown): number {
  return Array.isArray(content) ? content.filter(part => isRecord(part) && part.type === 'image').length : 0
}

function partsOf(content: unknown): AssistantPart[] {
  if (!Array.isArray(content)) return []
  const parts: AssistantPart[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) parts.push({ kind: 'text', text: block.text })
    else if (block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) parts.push({ kind: 'reasoning', text: block.text })
    else if (block.type === 'tool-call') parts.push({ kind: 'tool', callId: String(block.id ?? ''), name: String(block.name ?? 'tool'), args: String(block.arguments ?? '') })
  }
  return parts
}

function errorMessage(value: unknown): { message: string; code?: string } | null {
  if (!isRecord(value)) return null
  const reason = isRecord(value.reason) ? value.reason : value
  if (reason.kind !== 'error') return null
  const error = isRecord(reason.error) ? reason.error : isRecord(reason.failure) ? reason.failure : {}
  return { message: typeof error.message === 'string' ? error.message : 'エラーが発生しました', code: typeof error.code === 'string' ? error.code : undefined }
}

/** 永続イベント列 + ライブ断片 → 表示アイテム */
export function buildItems(events: WireEvent[], live: LiveAttempt | null): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, ToolPart>()
  for (const event of events) {
    const data = isRecord(event.data) ? event.data : {}
    switch (event.type) {
      case 'user/message': {
        const source = isRecord(data.source) ? data.source : {}
        if (source.kind !== 'user') break
        items.push({ kind: 'user', key: `u${event.seq}`, time: event.time, text: textOf(data.content), images: countImages(data.content) })
        break
      }
      case 'assistant/message': {
        const message = isRecord(data.message) ? data.message : {}
        const parts = partsOf(message.content)
        for (const part of parts) if (part.kind === 'tool') tools.set(part.callId, part)
        const source = isRecord(message.source) ? message.source : {}
        if (parts.length > 0) {
          items.push({ kind: 'assistant', key: `a${event.seq}`, time: event.time, parts, interrupted: data.interrupted === true, model: typeof source.model === 'string' ? source.model : undefined })
        }
        break
      }
      case 'tool/result': {
        const message = isRecord(data.message) ? data.message : {}
        const source = isRecord(message.source) ? message.source : {}
        const part = tools.get(String(source.callId ?? message.toolCallId ?? ''))
        if (part) part.result = { text: textOf(message.content), isError: message.isError === true }
        break
      }
      case 'turn/end': {
        const failure = errorMessage(data)
        if (failure) items.push({ kind: 'error', key: `e${event.seq}`, time: event.time, ...failure })
        else if (isRecord(data.reason) && data.reason.kind === 'cancelled') items.push({ kind: 'notice', key: `n${event.seq}`, time: event.time, text: '中断しました' })
        break
      }
      default:
        break
    }
  }
  if (live && live.blocks.length > 0) {
    const parts: AssistantPart[] = []
    for (const block of live.blocks) {
      if (!block) continue
      if (block.type === 'text' && block.text) parts.push({ kind: 'text', text: block.text })
      else if (block.type === 'reasoning' && block.text) parts.push({ kind: 'reasoning', text: block.text })
      else if (block.type === 'tool-call') parts.push({ kind: 'tool', callId: block.id ?? '', name: block.name ?? '…', args: block.text })
    }
    if (parts.length > 0) items.push({ kind: 'assistant', key: `live-${live.attemptId}`, time: Date.now(), parts, live: true })
  }
  // 結果を反映した ToolPart のコピーで描画を確実に更新させる
  return items.map(item => item.kind === 'assistant' ? { ...item, parts: item.parts.map(p => p.kind === 'tool' ? { ...p, result: tools.get(p.callId)?.result ?? p.result } : p) } : item)
}

/** 指定セッションを購読し、表示用の状態を返す */
export function useSession(sessionId: string | null) {
  const [state, dispatch] = useReducer(reducer, initial)
  const generation = useRef(0)
  useEffect(() => {
    dispatch({ type: 'reset' })
    if (!sessionId) return
    const gen = ++generation.current
    const close = mux.stream('session/follow', {
      request: { address: { kind: 'session', sessionId }, activate: true, assistantStream: true },
    }, {
      onItem: (value) => {
        if (gen !== generation.current || !isRecord(value)) return
        if (value.type === 'snapshot') dispatch({ type: 'snapshot', frame: value as unknown as SnapshotFrame })
        else if (value.type === 'event' && isRecord(value.event)) dispatch({ type: 'event', event: value.event as unknown as WireEvent })
        else if (value.type === 'assistant-stream' && isRecord(value.frame)) dispatch({ type: 'stream', frame: value.frame as unknown as StreamFrame })
      },
      onError: (error: RemoteError) => dispatch({ type: 'error', message: error.message }),
    })
    // モデル選択・コンテキスト使用量などの集計値はプロジェクションのストリームで更新される
    const closeProjections = mux.stream('session/observeProjections', { request: { sessionId } }, {
      onItem: (value) => {
        if (gen !== generation.current || !isRecord(value) || value.type !== 'projection' || !Array.isArray(value.changes)) return
        dispatch({ type: 'projections', changes: value.changes as { key: string; val: unknown }[] })
      },
    })
    return () => {
      close()
      closeProjections()
    }
  }, [sessionId])
  const items = useMemo(() => buildItems(state.events, state.live), [state.events, state.live])
  return { ...state, items }
}

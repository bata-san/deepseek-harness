import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle, ArrowDown, ArrowUp, Brain, Check, ChevronRight, Copy, FileCode2, Hand, Loader2, ShieldAlert, ShieldCheck,
  ImagePlus, Mic, Plus, Sparkles, Square, Terminal, Wrench, X, Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { ApprovalRequest, QuestionRequest } from '@/lib/app'
import type { ChatItem, ToolPart } from '@/lib/session'
import { cn, vibrate } from '@/lib/utils'

// ---------------------------------------------------------------------------
// メッセージ一覧
// ---------------------------------------------------------------------------
type Row =
  | { kind: 'item'; key: string; item: Exclude<ChatItem, { kind: 'assistant' }> }
  | { kind: 'text'; key: string; text: string; streaming: boolean }
  | { kind: 'reasoning'; key: string; text: string; live: boolean }
  | { kind: 'tools'; key: string; tools: ToolPart[]; live: boolean }
  | { kind: 'note'; key: string; text: string }

/** アシスタントの出力を「本文」「思考」「連続したツール実行のまとまり」に並べ替える */
function toRows(items: ChatItem[]): Row[] {
  const rows: Row[] = []
  for (const item of items) {
    if (item.kind !== 'assistant') {
      rows.push({ kind: 'item', key: item.key, item })
      continue
    }
    item.parts.forEach((part, index) => {
      const key = `${item.key}-${index}`
      const last = rows[rows.length - 1]
      if (part.kind === 'tool') {
        if (last?.kind === 'tools') {
          last.tools.push(part)
          last.live = last.live || Boolean(item.live)
        } else rows.push({ kind: 'tools', key, tools: [part], live: Boolean(item.live) })
      } else if (part.kind === 'text') {
        rows.push({ kind: 'text', key, text: part.text, streaming: Boolean(item.live) && index === item.parts.length - 1 })
      } else {
        rows.push({ kind: 'reasoning', key, text: part.text, live: Boolean(item.live) && index === item.parts.length - 1 })
      }
    })
    if (item.interrupted) rows.push({ kind: 'note', key: `${item.key}-int`, text: '途中で中断されました' })
  }
  return rows
}

export function MessageList({ items, running, status, emptyHint }: { items: ChatItem[]; running: boolean; status?: string; emptyHint: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const rows = useMemo(() => toRows(items), [items])

  const onScroll = () => {
    const el = scroller.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120
    stick.current = nearBottom
    setShowJump(!nearBottom)
  }

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [rows, running])

  const jump = () => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="scroll-touch h-full overflow-y-auto px-4 pb-6 pt-3">
        {rows.length === 0 && !running
          ? <div className="flex h-full items-center justify-center px-6 text-center">{emptyHint}</div>
          : (
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              {rows.map(row => <ChatRow key={row.key} row={row} />)}
              {running && (
                <div className="flex items-center gap-2.5 text-[14px]">
                  <WorkingDots />
                  <span className="font-medium text-brand">{status ?? '作業中…'}</span>
                </div>
              )}
            </div>
          )}
      </div>
      {showJump && (
        <button onClick={jump} aria-label="最新へ移動"
          className="absolute bottom-3 left-1/2 flex size-10 -translate-x-1/2 items-center justify-center rounded-full border bg-card shadow-lg">
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  )
}

function WorkingDots() {
  return (
    <span className="grid size-4 grid-cols-2 gap-[3px]" aria-hidden>
      {[0, 1, 2, 3].map(i => (
        <span key={i} className="size-[6px] animate-pulse rounded-full bg-brand" style={{ animationDelay: `${i * 180}ms` }} />
      ))}
    </span>
  )
}

const ChatRow = memo(function ChatRow({ row }: { row: Row }) {
  if (row.kind === 'text') return <Markdown text={row.text} streaming={row.streaming} />
  if (row.kind === 'reasoning') return <Reasoning text={row.text} live={row.live} />
  if (row.kind === 'tools') return <ToolGroup tools={row.tools} live={row.live} />
  if (row.kind === 'note') return <div className="text-sm text-muted-foreground">{row.text}</div>
  const item = row.item
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end pl-12">
        <div className="max-w-full whitespace-pre-wrap break-words rounded-3xl bg-secondary px-3.5 py-2 text-[15px] leading-relaxed text-foreground">
          {item.text || (item.images > 0 ? `画像 ${item.images} 枚` : '')}
          {item.text && item.images > 0 && <div className="mt-1 text-xs opacity-70">＋画像 {item.images} 枚</div>}
        </div>
      </div>
    )
  }
  if (item.kind === 'error') {
    return (
      <div className="flex gap-2.5 rounded-2xl bg-destructive/10 p-3 text-[14px]">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0 break-words leading-relaxed text-foreground/90">{explainError(item.message, item.code)}</div>
      </div>
    )
  }
  return <div className="text-center text-sm text-muted-foreground">{item.text}</div>
})

function explainError(message: string, code?: string): string {
  if (code === 'NO_ADAPTER' || /no adapter registered/.test(message)) {
    return 'AI モデルがまだ設定されていません。「設定」→「AI モデル」でプロバイダーと API キーを登録してください。'
  }
  if (/401|unauthori[sz]ed|invalid api key/i.test(message)) return `API キーが無効の可能性があります（${message}）`
  return message
}

const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={cn('prose-chat text-[15px] leading-[1.75]', streaming && 'after:ml-0.5 after:inline-block after:h-4 after:w-1.5 after:animate-pulse after:bg-foreground/60 after:align-middle')}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ pre: CodeBlock, a: ({ ...props }) => <a {...props} target="_blank" rel="noreferrer" /> }}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

function CodeBlock({ children, ...props }: React.HTMLAttributes<HTMLPreElement>) {
  const ref = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(ref.current?.innerText ?? '')
      setCopied(true)
      vibrate()
      window.setTimeout(() => setCopied(false), 1500)
    } catch { /* クリップボード不可 */ }
  }
  return (
    <div className="group relative">
      <pre ref={ref} {...props}>{children}</pre>
      <button onClick={copy} aria-label="コピー" className="absolute right-1.5 top-1.5 rounded-md bg-card/90 p-1.5 text-muted-foreground shadow-sm">
        {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  )
}

function Reasoning({ text, live }: { text: string; live?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1.5 text-left text-[14px] text-muted-foreground">
        <Brain className="size-4" />
        <span>{live ? '思考中…' : '思考しました'}</span>
        <ChevronRight className={cn('size-4 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="mt-2 whitespace-pre-wrap break-words border-l-2 pl-3 text-sm leading-relaxed text-muted-foreground">{text}</div>}
    </div>
  )
}

const TOOL_ICON: Record<string, typeof Wrench> = { bash: Terminal, pwsh: Terminal, shell: Terminal, read: FileCode2, write: FileCode2, edit: FileCode2 }

function toolSummary(part: ToolPart): string {
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(part.args || '{}') as Record<string, unknown> } catch { return part.args.slice(0, 80) }
  const pick = ['command', 'path', 'file_path', 'pattern', 'url', 'query', 'description', 'prompt', 'message']
  for (const key of pick) if (typeof args[key] === 'string' && args[key]) return String(args[key]).split('\n')[0].slice(0, 120)
  const first = Object.values(args).find(v => typeof v === 'string')
  return typeof first === 'string' ? first.slice(0, 120) : ''
}

const COMMAND_TOOLS = new Set(['bash', 'pwsh', 'shell', 'powershell', 'job_start', 'jobs'])
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'list', 'ls', 'web_fetch', 'web_search'])
const EDIT_TOOLS = new Set(['write', 'edit', 'multi_edit', 'apply_patch'])

function groupLabel(tools: ToolPart[]): string {
  let commands = 0, reads = 0, edits = 0, other = 0
  for (const t of tools) {
    if (COMMAND_TOOLS.has(t.name)) commands += 1
    else if (READ_TOOLS.has(t.name)) reads += 1
    else if (EDIT_TOOLS.has(t.name)) edits += 1
    else other += 1
  }
  const parts = []
  if (commands) parts.push(`${commands} 件のコマンドを実行しました`)
  if (reads) parts.push(`${reads} 件のファイルを読みました`)
  if (edits) parts.push(`${edits} 件のファイルを編集しました`)
  if (other) parts.push(`${other} 件のツールを使いました`)
  return parts.join('、')
}

function ToolGroup({ tools, live }: { tools: ToolPart[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const pending = tools.some(t => !t.result)
  const failed = tools.filter(t => t.result?.isError).length
  return (
    <div>
      <button onClick={() => { setOpen(!open); vibrate(5) }} className="flex max-w-full items-center gap-1.5 text-left text-[14px] text-muted-foreground">
        {pending && live ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
        <span className="truncate">{pending ? (live ? '実行中' : groupLabel(tools)) : groupLabel(tools)}</span>
        {failed > 0 && <span className="shrink-0 text-destructive">（失敗 {failed}）</span>}
        <ChevronRight className={cn('size-4 shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="mt-2 flex flex-col gap-2">{tools.map((t, i) => <ToolCard key={t.callId || i} part={t} live={live} />)}</div>}
    </div>
  )
}

function ToolCard({ part, live }: { part: ToolPart; live?: boolean }) {
  const [open, setOpen] = useState(false)
  const Icon = TOOL_ICON[part.name] ?? Wrench
  const pending = !part.result
  const summary = toolSummary(part)
  return (
    <div className={cn('overflow-hidden rounded-xl border bg-card', part.result?.isError && 'border-destructive/40')}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium">{part.name}</div>
          {summary && <div className="truncate font-mono text-[11px] text-muted-foreground">{summary}</div>}
        </div>
        {pending
          ? (live ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : <Loader2 className="size-4 animate-spin text-primary" />)
          : part.result?.isError ? <X className="size-4 text-destructive" /> : <Check className="size-4 text-success" />}
        <ChevronRight className={cn('size-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="border-t bg-muted/40 px-3 py-2 text-[11px]">
          <div className="mb-1 font-medium text-muted-foreground">引数</div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono">{prettyJson(part.args)}</pre>
          {part.result && (
            <>
              <div className="mb-1 mt-2 font-medium text-muted-foreground">結果</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all font-mono">{part.result.text || '（出力なし）'}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function prettyJson(text: string): string {
  try { return JSON.stringify(JSON.parse(text), null, 2) } catch { return text }
}

// ---------------------------------------------------------------------------
// 承認・質問
// ---------------------------------------------------------------------------
export function ApprovalCard({ approval, onResolve }: { approval: ApprovalRequest; onResolve: (outcome: 'allowed-once' | 'rejected') => void }) {
  const [busy, setBusy] = useState(false)
  const reason = approval.request.displayReason?.ja ?? approval.request.displayReason?.en ?? approval.request.reason
  const act = (outcome: 'allowed-once' | 'rejected') => {
    setBusy(true)
    vibrate(15)
    onResolve(outcome)
  }
  return (
    <div className="rounded-2xl border border-warning/40 bg-card p-3 shadow-lg">
      <div className="flex items-start gap-2.5">
        <div className="rounded-full bg-warning/15 p-2"><ShieldAlert className="size-5 text-warning" /></div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold">実行の許可が必要です</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Badge variant="warning">{approval.request.toolName ?? 'ツール'}</Badge>
          </div>
          {reason && <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] text-muted-foreground">{reason}</p>}
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="outline" size="lg" disabled={busy} onClick={() => act('rejected')}><Hand />拒否</Button>
        <Button variant="success" size="lg" disabled={busy} onClick={() => act('allowed-once')}><ShieldCheck />許可</Button>
      </div>
    </div>
  )
}

export function QuestionCard({ question, onAnswer }: { question: QuestionRequest; onAnswer: (answers: { id: string; selected: string[]; custom?: string }[]) => void }) {
  const items = question.request.questions ?? []
  const [selected, setSelected] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const toggle = (id: string, label: string, multi?: boolean) => {
    vibrate()
    setSelected(prev => {
      const current = prev[id] ?? []
      if (multi) return { ...prev, [id]: current.includes(label) ? current.filter(l => l !== label) : [...current, label] }
      return { ...prev, [id]: current[0] === label ? [] : [label] }
    })
  }
  const submit = () => onAnswer(items.map(q => ({ id: q.id, selected: selected[q.id] ?? [], ...(custom[q.id]?.trim() ? { custom: custom[q.id].trim() } : {}) })))
  return (
    <div className="max-h-[60dvh] overflow-y-auto rounded-2xl border border-primary/30 bg-card p-3 shadow-lg">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Sparkles className="size-4 text-primary" />エージェントからの質問</div>
      <div className="flex flex-col gap-4">
        {items.map(q => (
          <div key={q.id}>
            {q.header && <div className="text-[11px] font-medium uppercase text-muted-foreground">{q.header}</div>}
            <div className="text-[15px] font-medium">{q.question}</div>
            {q.detail && <div className="mt-0.5 text-[13px] text-muted-foreground">{q.detail}</div>}
            <div className="mt-2 flex flex-col gap-1.5">
              {(q.options ?? []).map(option => {
                const active = (selected[q.id] ?? []).includes(option.label)
                return (
                  <button key={option.label} onClick={() => toggle(q.id, option.label, q.multiSelect)}
                    className={cn('rounded-xl border px-3 py-2.5 text-left text-sm transition-colors', active ? 'border-primary bg-primary/10' : 'bg-background')}>
                    <div className="font-medium">{option.label}</div>
                    {option.description && <div className="text-xs text-muted-foreground">{option.description}</div>}
                  </button>
                )
              })}
              <input value={custom[q.id] ?? ''} onChange={e => setCustom(prev => ({ ...prev, [q.id]: e.target.value }))}
                placeholder="自由に回答（任意）" className="h-10 rounded-xl border bg-background px-3 text-sm" />
            </div>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button variant="outline" onClick={() => onAnswer(items.map(q => ({ id: q.id, selected: [] })))}>スキップ</Button>
        <Button onClick={submit}>回答する</Button>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 入力欄
// ---------------------------------------------------------------------------
export type ImagePart = { type: 'image'; mediaType: string; data: string; name?: string }

/** 画像を長辺 2048px 以内の JPEG/PNG に縮めて base64 にする（通信量とトークンを抑える） */
async function toImagePart(file: File): Promise<ImagePart> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const mediaType = file.type === 'image/png' ? 'image/png' : 'image/jpeg'
  const url = canvas.toDataURL(mediaType, 0.85)
  return { type: 'image', mediaType, data: url.slice(url.indexOf(',') + 1), name: file.name }
}

type SpeechRecognitionLike = {
  lang: string
  interimResults: boolean
  continuous: boolean
  start: () => void
  stop: () => void
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null
  onend: (() => void) | null
  onerror: (() => void) | null
}

function speechCtor(): (new () => SpeechRecognitionLike) | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** コンテキスト使用率のリング。タップで内訳を表示 */
function ContextRing({ used, window }: { used: number; window: number }) {
  const [open, setOpen] = useState(false)
  const ratio = Math.min(1, used / window)
  const r = 9, c = 2 * Math.PI * r
  const color = ratio > 0.85 ? 'hsl(var(--destructive))' : ratio > 0.6 ? 'hsl(var(--warning))' : 'hsl(var(--muted-foreground))'
  return (
    <div className="relative">
      <button onClick={() => { setOpen(!open); vibrate(5) }} aria-label="コンテキスト使用量" className="flex size-9 items-center justify-center rounded-full">
        <svg viewBox="0 0 24 24" className="size-6 -rotate-90">
          <circle cx="12" cy="12" r={r} fill="none" stroke="hsl(var(--border))" strokeWidth="3" />
          <circle cx="12" cy="12" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={`${c * ratio} ${c}`} />
        </svg>
      </button>
      {open && (
        <div className="absolute bottom-11 right-0 z-20 w-max rounded-xl border bg-card px-3 py-2 text-xs shadow-xl">
          <div className="font-medium">コンテキスト {Math.round(ratio * 100)}%</div>
          <div className="text-muted-foreground">{compact(used)} / {compact(window)} トークン</div>
        </div>
      )}
    </div>
  )
}

export function Composer({ running, disabled, modelLabel, modeLabel, modeDanger, context, snippets, onModel, onMode, onSend, onStop }: {
  running: boolean
  disabled?: boolean
  modelLabel: string
  modeLabel: string
  modeDanger?: boolean
  onMode: () => void
  context?: { used: number; window: number } | null
  snippets: string[]
  onModel: () => void
  onSend: (text: string, mode: 'queue' | 'steer', images: ImagePart[]) => Promise<void>
  onStop: () => void
}) {
  const [text, setText] = useState(() => sessionStorage.getItem('kh.draft') ?? '')
  const [images, setImages] = useState<ImagePart[]>([])
  const fileInput = useRef<HTMLInputElement>(null)
  const [sending, setSending] = useState(false)
  const [steer, setSteer] = useState(false)
  const [menu, setMenu] = useState(false)
  const [listening, setListening] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)
  const recognition = useRef<SpeechRecognitionLike | null>(null)
  const voice = useMemo(() => speechCtor(), [])

  useEffect(() => {
    try { sessionStorage.setItem('kh.draft', text) } catch { /* ignore */ }
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [text])

  const send = async (value = text) => {
    const trimmed = value.trim()
    if ((!trimmed && images.length === 0) || sending) return
    setSending(true)
    setMenu(false)
    vibrate()
    try {
      await onSend(trimmed, running && steer ? 'steer' : 'queue', value === text ? images : [])
      if (value === text) {
        setText('')
        setImages([])
      }
      setSteer(false)
    } finally {
      setSending(false)
    }
  }

  const toggleVoice = () => {
    if (!voice) return
    if (listening) {
      recognition.current?.stop()
      return
    }
    const r = new voice()
    r.lang = 'ja-JP'
    r.interimResults = true
    r.continuous = false
    const base = text ? `${text} ` : ''
    r.onresult = (event) => {
      let spoken = ''
      for (let i = 0; i < event.results.length; i += 1) spoken += event.results[i][0].transcript
      setText(base + spoken)
    }
    r.onend = () => setListening(false)
    r.onerror = () => setListening(false)
    recognition.current = r
    setListening(true)
    vibrate(15)
    r.start()
  }

  const pickImages = async (files: FileList | null) => {
    if (!files) return
    const added: ImagePart[] = []
    for (const file of Array.from(files).slice(0, 8)) {
      try { added.push(await toImagePart(file)) } catch { /* 読めない画像は飛ばす */ }
    }
    setImages(prev => [...prev, ...added].slice(0, 8))
    setMenu(false)
  }

  const showStop = running && !text.trim() && images.length === 0
  return (
    <div className="px-3 pb-[max(env(safe-area-inset-bottom),0.75rem)] pt-1">
      {menu && (
        <div className="mx-auto mb-2 max-w-3xl overflow-hidden rounded-2xl border bg-card shadow-xl">
          <button onClick={() => fileInput.current?.click()} className="flex w-full items-center gap-2 border-b px-4 py-2.5 text-left text-[14px] active:bg-accent">
            <ImagePlus className="size-4" />画像を添付
          </button>
          <div className="px-4 pb-1 pt-3 text-xs font-medium text-muted-foreground">定型文</div>
          {snippets.map(snippet => (
            <button key={snippet} disabled={disabled || sending} onClick={() => void send(snippet)}
              className="block w-full px-4 py-2.5 text-left text-[14px] active:bg-accent">{snippet}</button>
          ))}
          {running && (
            <button onClick={() => { setSteer(!steer); setMenu(false); vibrate() }} className="flex w-full items-center gap-2 border-t px-4 py-2.5 text-left text-[14px] active:bg-accent">
              <Zap className={cn('size-4', steer && 'text-warning')} />{steer ? '割り込みモードを解除' : '割り込んで指示する'}
            </button>
          )}
        </div>
      )}
      <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden
        onChange={e => { void pickImages(e.target.files); e.target.value = '' }} />
      <div className={cn('mx-auto max-w-3xl rounded-[24px] border bg-card px-1.5 pb-1.5 pt-0.5 shadow-sm', steer && 'border-warning/60')}>
        {images.length > 0 && (
          <div className="no-scrollbar flex gap-2 overflow-x-auto px-2 pt-2">
            {images.map((img, i) => (
              <div key={i} className="relative shrink-0">
                <img src={`data:${img.mediaType};base64,${img.data}`} alt={img.name ?? ''} className="size-16 rounded-xl object-cover" />
                <button aria-label="画像を外す" onClick={() => setImages(images.filter((_, j) => j !== i))}
                  className="absolute -right-1.5 -top-1.5 flex size-5 items-center justify-center rounded-full bg-foreground text-background"><X className="size-3" /></button>
              </div>
            ))}
          </div>
        )}
        <textarea ref={area} rows={1} value={text} disabled={disabled}
          onChange={e => setText(e.target.value)}
          onFocus={() => setMenu(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              void send()
            }
          }}
          placeholder={disabled ? '接続中…' : running ? (steer ? '割り込んで指示（今の作業に反映）…' : 'メッセージをキューに追加…') : 'メッセージを入力…'}
          className="block max-h-[200px] w-full resize-none bg-transparent px-3 pb-1.5 pt-2.5 text-[16px] leading-6 outline-none placeholder:text-muted-foreground" />
        <div className="flex items-center gap-2">
          <button onClick={() => { setMenu(!menu); vibrate(5) }} aria-label="メニュー"
            className={cn('flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary', menu && 'bg-accent')}>
            <Plus className={cn('size-4 transition-transform', menu && 'rotate-45')} />
          </button>
          <button onClick={onMode} aria-label="モードと権限"
            className={cn('flex h-9 shrink-0 items-center gap-1 rounded-full bg-secondary px-2.5 text-[12px] font-medium', modeDanger && 'bg-destructive/15 text-destructive')}>
            {modeDanger ? <ShieldAlert className="size-4" /> : <ShieldCheck className="size-4" />}<span className="max-w-[4.5rem] truncate">{modeLabel}</span>
          </button>
          <button onClick={onModel} className="flex h-9 min-w-[3rem] flex-1 items-center rounded-full bg-secondary px-3 text-left text-[12px] font-medium">
            <span className="min-w-0 truncate">{modelLabel}</span>
          </button>
          {context && <ContextRing used={context.used} window={context.window} />}
          {voice && (
            <button onClick={toggleVoice} aria-label="音声入力"
              className={cn('flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary', listening && 'bg-destructive text-destructive-foreground')}>
              <Mic className="size-4" />
            </button>
          )}
          {showStop
            ? <button onClick={() => { vibrate(20); onStop() }} aria-label="停止" className="flex size-9 shrink-0 items-center justify-center rounded-full bg-secondary">
                <Square className="size-4 fill-current" />
              </button>
            : <button onClick={() => void send()} disabled={(!text.trim() && images.length === 0) || sending || disabled} aria-label="送信"
                className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground disabled:opacity-30">
                {sending ? <Loader2 className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}
              </button>}
        </div>
      </div>
    </div>
  )
}

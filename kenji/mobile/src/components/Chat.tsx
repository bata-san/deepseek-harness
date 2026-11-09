import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  AlertTriangle, ArrowDown, ArrowUp, Brain, Check, ChevronRight, Copy, FileCode2, Hand, Loader2, ShieldAlert, ShieldCheck,
  Sparkles, Square, Terminal, Wrench, X, Zap,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import type { ApprovalRequest, QuestionRequest } from '@/lib/app'
import type { AssistantPart, ChatItem, ToolPart } from '@/lib/session'
import { cn, vibrate } from '@/lib/utils'

// ---------------------------------------------------------------------------
// メッセージ一覧
// ---------------------------------------------------------------------------
export function MessageList({ items, running, emptyHint }: { items: ChatItem[]; running: boolean; emptyHint: React.ReactNode }) {
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [showJump, setShowJump] = useState(false)

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
  }, [items, running])

  const jump = () => {
    const el = scroller.current
    if (!el) return
    stick.current = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={scroller} onScroll={onScroll} className="scroll-touch h-full overflow-y-auto px-3 pb-4 pt-3">
        {items.length === 0 && !running
          ? <div className="flex h-full items-center justify-center px-6 text-center">{emptyHint}</div>
          : (
            <div className="mx-auto flex max-w-3xl flex-col gap-3">
              {items.map(item => <ChatRow key={item.key} item={item} />)}
              {running && !items.some(i => i.kind === 'assistant' && i.live) && (
                <div className="flex items-center gap-2 px-1 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" /> 考えています…
                </div>
              )}
            </div>
          )}
      </div>
      {showJump && (
        <button onClick={jump} aria-label="最新へ移動"
          className="absolute bottom-3 left-1/2 flex size-9 -translate-x-1/2 items-center justify-center rounded-full border bg-card shadow-md">
          <ArrowDown className="size-4" />
        </button>
      )}
    </div>
  )
}

const ChatRow = memo(function ChatRow({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <div className="flex justify-end pl-10">
        <div className="max-w-full whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[15px] leading-relaxed text-primary-foreground shadow-sm">
          {item.text || (item.images > 0 ? `画像 ${item.images} 枚` : '')}
          {item.text && item.images > 0 && <div className="mt-1 text-xs opacity-80">＋画像 {item.images} 枚</div>}
        </div>
      </div>
    )
  }
  if (item.kind === 'error') {
    return (
      <div className="flex gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <div className="font-medium text-destructive">エラー</div>
          <div className="break-words text-foreground/80">{explainError(item.message, item.code)}</div>
        </div>
      </div>
    )
  }
  if (item.kind === 'notice') {
    return <div className="text-center text-xs text-muted-foreground">{item.text}</div>
  }
  return <AssistantRow parts={item.parts} live={item.live} interrupted={item.interrupted} />
})

function explainError(message: string, code?: string): string {
  if (code === 'NO_ADAPTER' || /no adapter registered/.test(message)) {
    return 'AI モデルがまだ設定されていません。「設定」→「AI モデル」でプロバイダーと API キーを登録してください。'
  }
  if (/401|unauthori[sz]ed|invalid api key/i.test(message)) return `API キーが無効の可能性があります（${message}）`
  return message
}

function AssistantRow({ parts, live, interrupted }: { parts: AssistantPart[]; live?: boolean; interrupted?: boolean }) {
  return (
    <div className="flex flex-col gap-2 pr-2">
      {parts.map((part, index) => {
        if (part.kind === 'text') return <Markdown key={index} text={part.text} streaming={live && index === parts.length - 1} />
        if (part.kind === 'reasoning') return <Reasoning key={index} text={part.text} live={live && index === parts.length - 1} />
        return <ToolCard key={part.callId || index} part={part} live={live} />
      })}
      {interrupted && <div className="text-xs text-muted-foreground">（途中で中断されました）</div>}
    </div>
  )
}

const Markdown = memo(function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div className={cn('prose-chat text-[15px]', streaming && 'after:ml-0.5 after:inline-block after:h-4 after:w-1.5 after:animate-pulse after:bg-foreground/60 after:align-middle')}>
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
    <div className="rounded-xl bg-muted/60">
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground">
        <Brain className="size-3.5" />
        <span className="flex-1">{live ? '思考中…' : '思考の過程'}</span>
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && <div className="whitespace-pre-wrap break-words px-3 pb-3 text-xs leading-relaxed text-muted-foreground">{text}</div>}
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
export function Composer({ running, disabled, snippets, onSend, onStop }: {
  running: boolean
  disabled?: boolean
  snippets: string[]
  onSend: (text: string, mode: 'queue' | 'steer') => Promise<void>
  onStop: () => void
}) {
  const [text, setText] = useState(() => sessionStorage.getItem('kh.draft') ?? '')
  const [sending, setSending] = useState(false)
  const [steer, setSteer] = useState(false)
  const area = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    try { sessionStorage.setItem('kh.draft', text) } catch { /* ignore */ }
    const el = area.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`
  }, [text])

  const send = async (value = text) => {
    const trimmed = value.trim()
    if (!trimmed || sending) return
    setSending(true)
    vibrate()
    try {
      await onSend(trimmed, running && steer ? 'steer' : 'queue')
      if (value === text) setText('')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="border-t bg-background/95 px-2 pb-[max(env(safe-area-inset-bottom),0.5rem)] pt-2 backdrop-blur">
      {!text && snippets.length > 0 && (
        <div className="no-scrollbar mb-2 flex gap-1.5 overflow-x-auto px-1">
          {snippets.map(s => (
            <button key={s} disabled={disabled || sending} onClick={() => void send(s)}
              className="shrink-0 rounded-full border bg-card px-3 py-1.5 text-xs text-foreground/80 active:bg-accent disabled:opacity-50">
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="mx-auto flex max-w-3xl items-end gap-1.5">
        {running && (
          <button onClick={() => { setSteer(!steer); vibrate() }} aria-label="割り込みモード"
            className={cn('mb-1 flex size-9 shrink-0 items-center justify-center rounded-full border', steer ? 'border-warning bg-warning/15 text-warning' : 'text-muted-foreground')}>
            <Zap className="size-4" />
          </button>
        )}
        <div className="flex min-h-11 flex-1 items-end rounded-3xl border bg-card px-3.5 py-2 shadow-sm focus-within:ring-2 focus-within:ring-ring">
          <textarea ref={area} rows={1} value={text} disabled={disabled}
            onChange={e => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void send()
              }
            }}
            placeholder={disabled ? '接続中…' : running ? (steer ? '割り込んで指示（今の作業に反映）' : '次の指示を予約') : 'メッセージを入力'}
            className="max-h-[180px] w-full resize-none bg-transparent text-[16px] leading-6 outline-none placeholder:text-muted-foreground" />
        </div>
        {running && !text.trim()
          ? <Button size="icon" variant="destructive" className="mb-0.5 shrink-0 rounded-full" onClick={() => { vibrate(20); onStop() }} aria-label="停止"><Square className="fill-current" /></Button>
          : <Button size="icon" className="mb-0.5 shrink-0 rounded-full" disabled={!text.trim() || sending || disabled} onClick={() => void send()} aria-label="送信">
              {sending ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </Button>}
      </div>
    </div>
  )
}

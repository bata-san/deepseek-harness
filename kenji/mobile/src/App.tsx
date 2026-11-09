import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bot, Check, ChevronDown, FolderOpen, Loader2, Menu, MessageSquare, Package, Plus, Settings as SettingsIcon, ShieldAlert, WifiOff } from 'lucide-react'
import { ApprovalCard, Composer, MessageList, QuestionCard } from '@/components/Chat'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { DEFAULT_SNIPPETS, titleOf, useConnection, useInteractions, useLocal, useSessions, type SessionSummary } from '@/lib/app'
import { call, fetchMe, logout, mux, newId, type Me } from '@/lib/dsh'
import { useSession } from '@/lib/session'
import { cn, relativeTime, shortPath, vibrate } from '@/lib/utils'
import { Login } from '@/pages/Login'
import { Plugins } from '@/pages/Plugins'
import { Settings } from '@/pages/Settings'

type Tab = 'chat' | 'plugins' | 'settings'
type Catalog = { default: { provider: string; model: string }; groups: { id: string; name: string; models: { id: string; name: string; description?: string }[] }[] }

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined)

  useEffect(() => {
    fetchMe().then(setMe).catch(() => setMe(null))
    const onUnauthorized = () => setMe(null)
    window.addEventListener('kh:unauthorized', onUnauthorized)
    return () => window.removeEventListener('kh:unauthorized', onUnauthorized)
  }, [])

  useEffect(() => {
    if (!me) return
    mux.connect()
    return () => mux.close()
  }, [me])

  if (me === undefined) {
    return <div className="flex h-full items-center justify-center"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>
  }
  if (me === null) return <Login onLogin={setMe} />
  return <Shell me={me} onLogout={async () => { await logout(); setMe(null) }} />
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>('chat')
  const [sessionId, setSessionId] = useLocal<string | null>('kh.session', null)
  const [drawer, setDrawer] = useState(false)
  const [modelSheet, setModelSheet] = useState(false)
  const [snippets] = useLocal<string[]>('kh.snippets', DEFAULT_SNIPPETS)
  const connection = useConnection()
  const { sessions, refresh } = useSessions(true)
  const interactions = useInteractions(connection === 'open')
  const session = useSession(sessionId)
  const current = sessions.find(s => s.sessionId === sessionId)

  // 消えたセッションを開いていたら外す
  useEffect(() => {
    if (sessionId && session.error) setSessionId(null)
  }, [sessionId, session.error, setSessionId])

  const myApprovals = interactions.approvals.filter(a => !sessionId || a.agentId === sessionId || !sessions.some(s => s.sessionId === a.agentId))
  const otherApprovals = interactions.approvals.length - myApprovals.length
  const myQuestions = interactions.questions.filter(q => !sessionId || q.agentId === sessionId || !sessions.some(s => s.sessionId === q.agentId))

  const createSession = useCallback(async (cwd?: string | null) => {
    vibrate()
    const value = await call<{ sessionId: string }>('session/create', { request: cwd ? { cwd } : {} })
    setSessionId(value.sessionId)
    setTab('chat')
    setDrawer(false)
    void refresh()
    return value.sessionId
  }, [refresh, setSessionId])

  const send = useCallback(async (text: string, mode: 'queue' | 'steer') => {
    let id = sessionId
    if (!id) id = await createSession(me.workspace)
    await call('session/prompt', {
      request: { requestId: newId(), sessionId: id, mode, content: [{ type: 'text', text }], clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    })
    void refresh()
  }, [sessionId, createSession, me.workspace, refresh])

  const stop = useCallback(() => {
    if (sessionId) void call('session/cancel', { request: { sessionId } }).catch(() => undefined)
  }, [sessionId])

  const title = sessionId ? (session.title ?? titleOf(current)) : '新しいチャット'

  return (
    <div className="flex h-full flex-col bg-background">
      {/* ヘッダー */}
      <header className="flex shrink-0 items-center gap-1 border-b bg-background/95 px-1.5 pb-1.5 pt-[max(env(safe-area-inset-top),0.375rem)] backdrop-blur">
        <Button variant="ghost" size="icon" onClick={() => setDrawer(true)} aria-label="チャット一覧">
          <Menu className="size-5" />
        </Button>
        <div className="min-w-0 flex-1 px-1">
          {tab === 'chat'
            ? (
              <>
                <div className="truncate text-[15px] font-semibold leading-tight">{title}</div>
                <button onClick={() => setModelSheet(true)} className="flex max-w-full items-center gap-1 truncate text-[11px] text-muted-foreground">
                  <Bot className="size-3 shrink-0" />
                  <span className="truncate">{session.modelSelection ? `${session.modelSelection.model}` : 'モデルを選択'}</span>
                  <ChevronDown className="size-3 shrink-0" />
                  {session.cwd && <span className="truncate">· {shortPath(session.cwd, interactions.home)}</span>}
                </button>
              </>
            )
            : <div className="text-[15px] font-semibold">{tab === 'plugins' ? 'プラグイン' : '設定'}</div>}
        </div>
        {connection !== 'open' && (
          <Badge variant="warning" className="mr-1"><WifiOff className="size-3" />{connection === 'connecting' ? '接続中' : '切断'}</Badge>
        )}
        {tab === 'chat' && (
          <Button variant="ghost" size="icon" onClick={() => void createSession(me.workspace)} aria-label="新しいチャット">
            <Plus className="size-5" />
          </Button>
        )}
      </header>

      {otherApprovals > 0 && (
        <button onClick={() => setDrawer(true)} className="flex shrink-0 items-center gap-2 bg-warning/15 px-3 py-1.5 text-xs font-medium text-warning">
          <ShieldAlert className="size-4" />ほかのチャットで承認待ちが {otherApprovals} 件あります
        </button>
      )}

      {/* 本体 */}
      <main className="flex min-h-0 flex-1 flex-col">
        {tab === 'chat' && (
          <>
            <MessageList items={session.items} running={session.running} emptyHint={<EmptyHint me={me} />} />
            {(myApprovals.length > 0 || myQuestions.length > 0) && (
              <div className="flex shrink-0 flex-col gap-2 px-2 pb-2">
                {myApprovals.map(a => <ApprovalCard key={a.eventId} approval={a} onResolve={(o) => void interactions.resolveApproval(a, o)} />)}
                {myQuestions.map(q => <QuestionCard key={q.eventId} question={q} onAnswer={(ans) => void interactions.answerQuestion(q, ans)} />)}
              </div>
            )}
            <Composer running={session.running} disabled={connection !== 'open'} snippets={snippets} onSend={send} onStop={stop} />
          </>
        )}
        {tab === 'plugins' && <Plugins />}
        {tab === 'settings' && <Settings me={me} onLogout={onLogout} />}
      </main>

      {/* タブバー（チャット中はキーボード操作を優先して小さめ） */}
      <nav className={cn('grid shrink-0 grid-cols-3 border-t bg-background', tab !== 'chat' && 'pb-[env(safe-area-inset-bottom)]')}>
        {([['chat', 'チャット', MessageSquare], ['plugins', 'プラグイン', Package], ['settings', '設定', SettingsIcon]] as const).map(([id, label, Icon]) => (
          <button key={id} onClick={() => { setTab(id); vibrate(5) }}
            className={cn('flex flex-col items-center gap-0.5 py-1.5 text-[10px]', tab === id ? 'text-primary' : 'text-muted-foreground')}>
            <Icon className="size-5" />{label}
          </button>
        ))}
      </nav>

      <SessionDrawer open={drawer} onOpenChange={setDrawer} sessions={sessions} current={sessionId} home={interactions.home} me={me}
        pending={new Set(interactions.approvals.map(a => a.agentId))}
        onSelect={(id) => { setSessionId(id); setTab('chat'); setDrawer(false); vibrate() }}
        onCreate={(cwd) => void createSession(cwd)} />

      <ModelSheet open={modelSheet} onOpenChange={setModelSheet} sessionId={sessionId} current={session.modelSelection ?? null}
        onOpenSettings={() => { setModelSheet(false); setTab('settings') }} />
    </div>
  )
}

function EmptyHint({ me }: { me: Me }) {
  return (
    <div className="flex flex-col items-center gap-3 text-muted-foreground">
      <div className="rounded-2xl bg-muted p-4"><Bot className="size-8" /></div>
      <div className="text-[15px] font-medium text-foreground">何をしましょうか？</div>
      <div className="text-xs leading-relaxed">
        PC 上のエージェントにそのまま指示できます。
        {me.workspace && <><br />作業フォルダ: <span className="font-mono">{shortPath(me.workspace)}</span></>}
      </div>
    </div>
  )
}

function SessionDrawer({ open, onOpenChange, sessions, current, home, me, pending, onSelect, onCreate }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: SessionSummary[]
  current: string | null
  home: string
  me: Me
  pending: Set<string>
  onSelect: (id: string) => void
  onCreate: (cwd: string | null) => void
}) {
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState('')
  const [showFolder, setShowFolder] = useState(false)
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sessions.filter(s => !s.blank || s.sessionId === current).filter(s => !q || titleOf(s).toLowerCase().includes(q) || (s.cwd ?? '').toLowerCase().includes(q))
  }, [sessions, query, current])

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" title="チャット">
        <div className="flex flex-col gap-2 px-3 pb-2">
          <Button onClick={() => onCreate(me.workspace ?? null)} className="w-full"><Plus />新しいチャット</Button>
          <button onClick={() => setShowFolder(!showFolder)} className="flex items-center gap-1.5 self-start text-xs text-muted-foreground">
            <FolderOpen className="size-3.5" />フォルダを指定して開始
          </button>
          {showFolder && (
            <div className="flex gap-2">
              <Input value={folder} onChange={e => setFolder(e.target.value)} placeholder="C:\path\to\project" className="h-10 font-mono text-sm" autoCapitalize="none" />
              <Button variant="outline" disabled={!folder.trim()} onClick={() => onCreate(folder.trim())}>開始</Button>
            </div>
          )}
          <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="検索" className="h-10" />
        </div>
        <div className="scroll-touch min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {filtered.map(s => (
            <button key={s.sessionId} onClick={() => onSelect(s.sessionId)}
              className={cn('flex w-full items-start gap-2.5 rounded-xl px-3 py-2.5 text-left', s.sessionId === current ? 'bg-accent' : 'active:bg-accent')}>
              <div className="mt-1">
                {pending.has(s.sessionId)
                  ? <ShieldAlert className="size-4 text-warning" />
                  : s.running ? <Loader2 className="size-4 animate-spin text-primary" /> : <MessageSquare className="size-4 text-muted-foreground" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{titleOf(s)}</div>
                <div className="truncate text-[11px] text-muted-foreground">{relativeTime(s.updatedAt)}{s.cwd ? ` · ${shortPath(s.cwd, home)}` : ''}</div>
              </div>
            </button>
          ))}
          {filtered.length === 0 && <div className="py-10 text-center text-sm text-muted-foreground">チャットはまだありません</div>}
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ModelSheet({ open, onOpenChange, sessionId, current, onOpenSettings }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string | null
  current: { provider: string; model: string } | null
  onOpenSettings: () => void
}) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    call<Catalog>('session/modelCatalog').then(setCatalog).catch(e => setError((e as Error).message))
  }, [open])

  const active = current ?? catalog?.default ?? null

  const select = async (provider: string, model: string) => {
    if (!sessionId) {
      setError('先にチャットを開始してください')
      return
    }
    setBusy(`${provider}/${model}`)
    try {
      await call('session/selectModel', { request: { sessionId, provider, model } })
      vibrate()
      onOpenChange(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title="モデル" description="このチャットで使うモデルを選びます">
        <div className="scroll-touch min-h-0 overflow-y-auto px-3 pb-4">
          {!catalog && !error && <div className="flex justify-center py-8"><Loader2 className="animate-spin text-muted-foreground" /></div>}
          {error && <p className="mb-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          {catalog && catalog.groups.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-6 text-center text-sm text-muted-foreground">
              使えるモデルがありません。API キーを登録してください。
              <Button onClick={onOpenSettings}>AI モデルを設定</Button>
            </div>
          )}
          {catalog?.groups.map(group => (
            <div key={group.id} className="mb-3">
              <div className="px-1 pb-1 text-xs font-medium text-muted-foreground">{group.name}</div>
              <div className="flex flex-col overflow-hidden rounded-xl border">
                {group.models.map(model => {
                  const selected = active?.provider === group.id && active?.model === model.id
                  return (
                    <button key={model.id} onClick={() => void select(group.id, model.id)}
                      className={cn('flex items-center gap-2 border-b px-3 py-2.5 text-left last:border-b-0', selected && 'bg-primary/5')}>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm">{model.name || model.id}</div>
                        {model.description && <div className="truncate text-[11px] text-muted-foreground">{model.description}</div>}
                      </div>
                      {busy === `${group.id}/${model.id}` ? <Loader2 className="size-4 animate-spin" /> : selected && <Check className="size-4 text-primary" />}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  )
}

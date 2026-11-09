import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ArrowLeft, Check, ChevronDown, Folder, FolderOpen, Loader2, LogOut, Menu, Monitor, MoreVertical, Package, Plus, RefreshCw, Search, Server,
  Settings as SettingsIcon, ShieldAlert, WifiOff, X,
} from 'lucide-react'
import { ApprovalCard, Composer, MessageList, QuestionCard, type ImagePart } from '@/components/Chat'
import { ModeSheet, PERMISSION_LABELS, modeName } from '@/components/ModeSheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { DEFAULT_SNIPPETS, titleOf, useConnection, useInteractions, useLocal, useSessions, type SessionSummary } from '@/lib/app'
import { call, fetchMe, logout, mux, newId, type Me } from '@/lib/dsh'
import { contextUsage, useSession } from '@/lib/session'
import { cn, relativeTime, shortPath, vibrate } from '@/lib/utils'
import { Login } from '@/pages/Login'
import { Plugins } from '@/pages/Plugins'
import { Settings } from '@/pages/Settings'

type View = 'home' | 'chat' | 'plugins' | 'settings'
type Effort = { id: string; name: string; description?: string }
type CatalogModel = { id: string; name: string; description?: string; reasoning?: { efforts: Effort[]; defaultEffort?: string } }
type Catalog = { default: { provider: string; model: string; reasoningEffort?: string }; groups: { id: string; name: string; models: CatalogModel[] }[] }
type Selection = { provider: string; model: string; reasoningEffort?: string }

/** モデル一覧を一度だけ取得して共有する（思考レベルの名前表示にも使う） */
function useCatalog(trigger: unknown) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    setError('')
    call<Catalog>('session/modelCatalog').then(setCatalog).catch(e => setError((e as Error).message))
  }, [])
  useEffect(() => { load() }, [load, trigger])
  return { catalog, error, reload: load }
}

function findModel(catalog: Catalog | null, sel: Selection | null): CatalogModel | undefined {
  if (!catalog || !sel) return undefined
  return catalog.groups.find(g => g.id === sel.provider)?.models.find(m => m.id === sel.model)
}

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

/** 画面上部のバー（左・中央・右） */
function TopBar({ left, title, subtitle, right, onTitle }: {
  left?: React.ReactNode
  title: string
  subtitle?: React.ReactNode
  right?: React.ReactNode
  onTitle?: () => void
}) {
  return (
    <header className="grid shrink-0 grid-cols-[3rem_1fr_3rem] items-center px-2 pb-2 pt-[max(env(safe-area-inset-top),0.5rem)]">
      <div className="flex justify-start">{left}</div>
      <button onClick={onTitle} disabled={!onTitle} className="flex min-w-0 flex-col items-center px-1 text-center">
        <span className="max-w-full truncate text-[16px] font-semibold leading-tight">{title}</span>
        {subtitle && <span className="flex max-w-full items-center gap-1 truncate text-[12px] text-muted-foreground">{subtitle}</span>}
      </button>
      <div className="flex justify-end">{right}</div>
    </header>
  )
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button aria-label={label} onClick={() => { vibrate(5); onClick() }} className="flex size-11 items-center justify-center rounded-full active:bg-accent">
      {children}
    </button>
  )
}

function Shell({ me, onLogout }: { me: Me; onLogout: () => void }) {
  const [view, setView] = useState<View>('home')
  const [sessionId, setSessionId] = useLocal<string | null>('kh.session', null)
  const [menu, setMenu] = useState(false)
  const [modelSheet, setModelSheet] = useState(false)
  const [modeSheet, setModeSheet] = useState(false)
  const [defaults, setDefaults] = useLocal<{ mode?: string; permission?: string }>('kh.defaults', {})
  const [snippets] = useLocal<string[]>('kh.snippets', DEFAULT_SNIPPETS)
  const connection = useConnection()
  const { sessions, loading, refresh } = useSessions(true)
  const interactions = useInteractions(connection === 'open')
  const session = useSession(view === 'chat' ? sessionId : null)
  const current = sessions.find(s => s.sessionId === sessionId)
  const pendingIds = useMemo(() => new Set([...interactions.approvals.map(a => a.agentId), ...interactions.questions.map(q => q.agentId)]), [interactions.approvals, interactions.questions])

  // ブラウザの「戻る」でホームへ
  useEffect(() => {
    const onPop = () => setView('home')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const go = useCallback((next: View) => {
    if (next !== 'home') window.history.pushState({ view: next }, '')
    setView(next)
  }, [])
  const back = () => {
    if (window.history.state?.view) window.history.back()
    else setView('home')
  }

  useEffect(() => {
    if (sessionId && session.error) {
      setSessionId(null)
      setView('home')
    }
  }, [sessionId, session.error, setSessionId])

  const open = (id: string) => {
    setSessionId(id)
    go('chat')
  }

  const createSession = useCallback(async (cwd?: string | null) => {
    vibrate()
    const value = await call<{ sessionId: string }>('session/create', { request: { ...(cwd ? { cwd } : {}), ...(defaults.mode ? { agentPreset: defaults.mode } : {}) } })
    if (defaults.permission) {
      await call('commands/execute', { agentId: value.sessionId, line: `/permission ${defaults.permission}`, submittedAttachments: [] }).catch(() => undefined)
    }
    setSessionId(value.sessionId)
    go('chat')
    void refresh()
    return value.sessionId
  }, [refresh, setSessionId, go, defaults])

  const send = useCallback(async (text: string, mode: 'queue' | 'steer', images: ImagePart[] = []) => {
    let id = sessionId
    if (!id) id = await createSession(me.workspace)
    const content = [...(text ? [{ type: 'text', text }] : []), ...images]
    await call('session/prompt', {
      request: { requestId: newId(), sessionId: id, mode, content, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    })
    void refresh()
  }, [sessionId, createSession, me.workspace, refresh])

  const stop = useCallback(() => {
    if (sessionId) void call('session/cancel', { request: { sessionId } }).catch(() => undefined)
  }, [sessionId])

  const { catalog, error: catalogError, reload: reloadCatalog } = useCatalog(view)
  const selection: Selection | null = session.modelSelection ?? catalog?.default ?? null
  const selectedModel = findModel(catalog, selection)
  const effortId = selection?.reasoningEffort ?? selectedModel?.reasoning?.defaultEffort
  const effortName = selectedModel?.reasoning?.efforts.find(e => e.id === effortId)?.name ?? effortId
  const modelLabel = selection ? `${selectedModel?.name ?? selection.model}${effortName ? ` · ${effortName}` : ''}` : 'モデル'

  const proj = session.projections as { agentPreset?: string; permissions?: { currentValue?: string }; plan?: { active?: boolean } }
  const currentMode = sessionId ? (proj.agentPreset ?? undefined) : defaults.mode
  const currentPermission = sessionId ? proj.permissions?.currentValue : defaults.permission
  const modeLabel = `${modeName(currentMode)}${currentPermission ? `・${PERMISSION_LABELS[currentPermission]?.short ?? currentPermission}` : ''}${proj.plan?.active ? '・計画' : ''}`

  const myApprovals = interactions.approvals.filter(a => a.agentId === sessionId || !sessions.some(s => s.sessionId === a.agentId))
  const myQuestions = interactions.questions.filter(q => q.agentId === sessionId || !sessions.some(s => s.sessionId === q.agentId))
  const otherPending = interactions.approvals.length + interactions.questions.length - myApprovals.length - myQuestions.length

  const offline = connection !== 'open' && (
    <span className="flex items-center gap-1 text-warning"><WifiOff className="size-3" />{connection === 'connecting' ? '接続中' : '切断'}</span>
  )

  return (
    <div className="flex h-full flex-col bg-background">
      {view === 'home' && (
        <Home me={me} sessions={sessions} loading={loading} pending={pendingIds} home={interactions.home} offline={offline}
          onMenu={() => setMenu(true)} onRefresh={() => void refresh()} onOpen={open} onCreate={(cwd) => void createSession(cwd)} />
      )}

      {view === 'chat' && (
        <>
          <TopBar
            left={<IconButton label="戻る" onClick={back}><ArrowLeft className="size-5" /></IconButton>}
            title={sessionId ? (session.title ?? titleOf(current)) : '新しいセッション'}
            subtitle={<>{offline || <><Folder className="size-3 shrink-0" /><span className="truncate">{shortPath(session.cwd ?? current?.cwd ?? me.workspace ?? '', interactions.home) || 'ワークスペース'}</span></>}</>}
            onTitle={() => setModelSheet(true)}
            right={session.running
              ? <div className="flex size-11 items-center justify-center"><Loader2 className="size-6 animate-spin text-brand" /></div>
              : <IconButton label="メニュー" onClick={() => setMenu(true)}><MoreVertical className="size-5" /></IconButton>}
          />
          {otherPending > 0 && (
            <button onClick={back} className="mx-3 mb-1 flex shrink-0 items-center gap-2 rounded-full bg-warning/15 px-3 py-1.5 text-xs font-medium text-warning">
              <ShieldAlert className="size-4" />ほかのセッションで応答待ちが {otherPending} 件
            </button>
          )}
          <MessageList items={session.items} running={session.running}
            status={myApprovals.length ? '承認待ち' : myQuestions.length ? '回答待ち' : '作業中…'}
            emptyHint={<EmptyHint me={me} />} />
          {(myApprovals.length > 0 || myQuestions.length > 0) && (
            <div className="flex shrink-0 flex-col gap-2 px-3 pb-2">
              {myApprovals.map(a => <ApprovalCard key={a.eventId} approval={a} onResolve={(o) => void interactions.resolveApproval(a, o)} />)}
              {myQuestions.map(q => <QuestionCard key={q.eventId} question={q} onAnswer={(ans) => void interactions.answerQuestion(q, ans)} />)}
            </div>
          )}
          <Composer running={session.running} disabled={connection !== 'open'} snippets={snippets}
            modelLabel={modelLabel} modeLabel={modeLabel} modeDanger={currentPermission === 'danger-full-access'} onMode={() => setModeSheet(true)}
            context={contextUsage(session.projections)} onModel={() => setModelSheet(true)} onSend={send} onStop={stop} />
        </>
      )}

      {(view === 'plugins' || view === 'settings') && (
        <>
          <TopBar left={<IconButton label="戻る" onClick={back}><ArrowLeft className="size-5" /></IconButton>}
            title={view === 'plugins' ? 'プラグイン' : '設定'} />
          <main className="min-h-0 flex-1">{view === 'plugins' ? <Plugins /> : <Settings me={me} onLogout={onLogout} />}</main>
        </>
      )}

      <MenuSheet open={menu} onOpenChange={setMenu} me={me}
        onNavigate={(v) => { setMenu(false); go(v) }}
        onNew={() => { setMenu(false); void createSession(me.workspace) }}
        onModel={() => { setMenu(false); setModelSheet(true) }}
        inChat={view === 'chat'} onLogout={onLogout} />

      <ModeSheet open={modeSheet} onOpenChange={setModeSheet} sessionId={view === 'chat' ? sessionId : null} mode={currentMode} permission={currentPermission}
        planActive={Boolean(proj.plan?.active)} onDefaults={(next) => setDefaults({ ...defaults, ...next })} />

      <ModelSheet open={modelSheet} onOpenChange={(o) => { setModelSheet(o); if (o) reloadCatalog() }} sessionId={sessionId} current={selection}
        catalog={catalog} error={catalogError} onOpenSettings={() => { setModelSheet(false); go('settings') }} />
    </div>
  )
}

type Filter = 'all' | 'running' | 'pending'

function Home({ me, sessions, loading, pending, home, offline, onMenu, onRefresh, onOpen, onCreate }: {
  me: Me
  sessions: SessionSummary[]
  loading: boolean
  pending: Set<string>
  home: string
  offline: React.ReactNode
  onMenu: () => void
  onRefresh: () => void
  onOpen: (id: string) => void
  onCreate: (cwd: string | null) => void
}) {
  const [filter, setFilter] = useState<Filter>('all')
  const [searching, setSearching] = useState(false)
  const [query, setQuery] = useState('')
  const [folderSheet, setFolderSheet] = useState(false)
  const [folder, setFolder] = useState('')

  const list = useMemo(() => {
    const q = query.trim().toLowerCase()
    return sessions
      .filter(s => !s.blank)
      .filter(s => filter === 'all' || (filter === 'running' ? s.running : pending.has(s.sessionId)))
      .filter(s => !q || titleOf(s).toLowerCase().includes(q) || (s.cwd ?? '').toLowerCase().includes(q))
  }, [sessions, filter, query, pending])

  const filterLabel = { all: 'すべて', running: '実行中', pending: '応答待ち' }[filter]
  const nextFilter: Record<Filter, Filter> = { all: 'running', running: 'pending', pending: 'all' }

  return (
    <>
      <TopBar
        left={<IconButton label="メニュー" onClick={onMenu}><Menu className="size-5" /></IconButton>}
        title="Harness"
        subtitle={offline || undefined}
        right={<IconButton label="再読み込み" onClick={onRefresh}><RefreshCw className={cn('size-5', loading && 'animate-spin')} /></IconButton>}
      />
      <div className="scroll-touch min-h-0 flex-1 overflow-y-auto px-5 pb-32">
        {searching && (
          <div className="sticky top-0 z-10 bg-background pb-3 pt-1">
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input autoFocus value={query} onChange={e => setQuery(e.target.value)} placeholder="セッションを検索" className="h-11 rounded-full pl-10" />
            </div>
          </div>
        )}
        <div className="mb-1 mt-3 flex items-center justify-between">
          <span className="text-[13px] text-muted-foreground">セッション</span>
          <button onClick={() => { setFilter(nextFilter[filter]); vibrate(5) }} className="flex items-center gap-1 text-[13px] text-muted-foreground">
            {filterLabel}<ChevronDown className="size-4" />
          </button>
        </div>
        <div className="flex flex-col">
          {list.map(s => {
            const waiting = pending.has(s.sessionId)
            return (
              <button key={s.sessionId} onClick={() => onOpen(s.sessionId)} className="-mx-2 flex items-start gap-3 rounded-2xl px-2 py-3 text-left active:bg-accent">
                <span className="mt-[5px] flex size-3 shrink-0 items-center justify-center">
                  {waiting
                    ? <span className="size-2.5 rounded-full bg-warning" />
                    : s.running ? <span className="size-2.5 animate-pulse rounded-full bg-brand" /> : <span className="size-2.5 rounded-full border-2 border-muted-foreground/60" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px] font-semibold leading-snug">{titleOf(s)}</span>
                  <span className="mt-0.5 flex items-center gap-1.5 truncate text-[13px] text-muted-foreground">
                    {waiting ? <><ShieldAlert className="size-3.5 shrink-0 text-warning" /><span className="text-warning">応答待ち</span></>
                      : <><Folder className="size-3.5 shrink-0" /><span className="truncate">{shortPath(s.cwd, home) || 'ワークスペース'}</span></>}
                  </span>
                </span>
                <span className="shrink-0 pt-0.5 text-[13px] text-muted-foreground">{relativeTime(s.updatedAt)}</span>
              </button>
            )
          })}
          {list.length === 0 && (
            <div className="py-16 text-center text-[15px] text-muted-foreground">
              {sessions.length === 0 ? 'まだセッションはありません' : '該当するセッションはありません'}
            </div>
          )}
        </div>
      </div>

      {/* 下部の操作 */}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 flex items-center justify-between px-5 pb-[max(env(safe-area-inset-bottom),1.25rem)]">
        <button aria-label="検索" onClick={() => { setSearching(!searching); setQuery(''); vibrate(5) }}
          className="pointer-events-auto flex size-12 items-center justify-center rounded-full border bg-card shadow-lg">
          {searching ? <X className="size-5" /> : <Search className="size-5" />}
        </button>
        <button onClick={() => onCreate(me.workspace ?? null)} onContextMenu={(e) => { e.preventDefault(); setFolderSheet(true) }}
          className="pointer-events-auto flex h-12 items-center gap-2 rounded-full bg-primary px-5 text-[15px] font-semibold text-primary-foreground shadow-lg active:scale-[0.98]">
          <Plus className="size-5" />新規セッション
        </button>
      </div>

      <Sheet open={folderSheet} onOpenChange={setFolderSheet}>
        <SheetContent title="フォルダを指定して開始" description="PC 上のフォルダでセッションを始めます">
          <div className="flex flex-col gap-3 px-4 pb-6">
            <Input value={folder} onChange={e => setFolder(e.target.value)} placeholder="C:\path\to\project" className="font-mono" autoCapitalize="none" />
            <Button size="lg" disabled={!folder.trim()} onClick={() => { setFolderSheet(false); onCreate(folder.trim()) }}><FolderOpen />開始</Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}

function EmptyHint({ me }: { me: Me }) {
  return (
    <div className="flex flex-col items-center gap-2 text-muted-foreground">
      <div className="text-[17px] font-semibold text-foreground">何をしましょうか？</div>
      <div className="text-sm leading-relaxed">
        PC 上のエージェントにそのまま指示できます。
        {me.workspace && <><br /><span className="font-mono text-xs">{shortPath(me.workspace)}</span></>}
      </div>
    </div>
  )
}

function MenuSheet({ open, onOpenChange, me, inChat, onNavigate, onNew, onModel, onLogout }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  me: Me
  inChat: boolean
  onNavigate: (view: View) => void
  onNew: () => void
  onModel: () => void
  onLogout: () => void
}) {
  const item = 'flex w-full items-center gap-3.5 px-5 py-3 text-left text-[15px] active:bg-accent'
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title={me.username} description={me.role}>
        <div className="pb-4">
          {inChat && <button className={item} onClick={onModel}><Server className="size-5 text-muted-foreground" />モデルを変更</button>}
          <button className={item} onClick={onNew}><Plus className="size-5 text-muted-foreground" />新規セッション</button>
          <button className={item} onClick={() => onNavigate('plugins')}><Package className="size-5 text-muted-foreground" />プラグイン</button>
          <button className={item} onClick={() => onNavigate('settings')}><SettingsIcon className="size-5 text-muted-foreground" />設定</button>
          <a className={item} href="./full/" target="_blank" rel="noreferrer"><Monitor className="size-5 text-muted-foreground" />PC 版の画面を開く</a>
          <a className={item} href="../"><Server className="size-5 text-muted-foreground" />Kenji に戻る</a>
          <button className={cn(item, 'text-destructive')} onClick={onLogout}><LogOut className="size-5" />ログアウト</button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

function ModelSheet({ open, onOpenChange, sessionId, current, catalog, error: loadError, onOpenSettings }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string | null
  current: Selection | null
  catalog: Catalog | null
  error: string
  onOpenSettings: () => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const currentModel = findModel(catalog, current)
  const efforts = currentModel?.reasoning?.efforts ?? []
  const activeEffort = current?.reasoningEffort ?? currentModel?.reasoning?.defaultEffort

  const select = async (provider: string, model: CatalogModel, reasoningEffort?: string, close = true) => {
    if (!sessionId) {
      setError('先にセッションを開始してください')
      return
    }
    const effort = reasoningEffort ?? (model.reasoning?.efforts.some(e => e.id === activeEffort) ? activeEffort : model.reasoning?.defaultEffort)
    setBusy(`${provider}/${model.id}/${reasoningEffort ?? ''}`)
    setError('')
    try {
      await call('session/selectModel', { request: { sessionId, provider, model: model.id, ...(effort ? { reasoningEffort: effort } : {}) } })
      vibrate()
      if (close) onOpenChange(false)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const q = query.trim().toLowerCase()
  const groups = (catalog?.groups ?? []).map(g => ({ ...g, models: g.models.filter(m => !q || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)) })).filter(g => g.models.length)
  const total = (catalog?.groups ?? []).reduce((n, g) => n + g.models.length, 0)

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title="モデル" description={currentModel ? `${currentModel.name}` : 'このセッションで使うモデル'}>
        <div className="scroll-touch min-h-0 overflow-y-auto px-3 pb-6">
          {(error || loadError) && <p className="mb-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error || loadError}</p>}
          {currentModel && efforts.length > 0 && current && (
            <div className="mb-4">
              <div className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">思考レベル</div>
              <div className="no-scrollbar flex gap-1.5 overflow-x-auto">
                {efforts.map(effort => {
                  const active = effort.id === activeEffort
                  const key = `${current.provider}/${currentModel.id}/${effort.id}`
                  return (
                    <button key={effort.id} onClick={() => void select(current.provider, currentModel, effort.id, false)} title={effort.description}
                      className={cn('flex shrink-0 items-center gap-1 rounded-full border px-3.5 py-1.5 text-[13px]', active ? 'border-transparent bg-primary text-primary-foreground' : 'bg-card')}>
                      {busy === key && <Loader2 className="size-3 animate-spin" />}{effort.name || effort.id}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          {!catalog && !loadError && <div className="flex justify-center py-8"><Loader2 className="animate-spin text-muted-foreground" /></div>}
          {catalog && total === 0 && (
            <div className="flex flex-col items-center gap-3 py-6 text-center text-[14px] text-muted-foreground">
              使えるモデルがありません。API キーを登録してください。
              <Button onClick={onOpenSettings}>AI モデルを設定</Button>
            </div>
          )}
          {total > 8 && (
            <div className="relative mb-3">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input value={query} onChange={e => setQuery(e.target.value)} placeholder="モデルを検索" className="h-10 rounded-full pl-9" />
            </div>
          )}
          {groups.map(group => (
            <div key={group.id} className="mb-3">
              <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.name}</div>
              <div className="flex flex-col overflow-hidden rounded-2xl bg-card">
                {group.models.map(model => {
                  const selected = current?.provider === group.id && current?.model === model.id
                  return (
                    <button key={model.id} onClick={() => void select(group.id, model)}
                      className="flex items-center gap-2 border-b px-4 py-2.5 text-left last:border-b-0 active:bg-accent">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[14px]">{model.name || model.id}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {model.description ?? model.id}
                          {model.reasoning?.efforts.length ? ` · 思考 ${model.reasoning.efforts.length} 段階` : ''}
                        </div>
                      </div>
                      {busy?.startsWith(`${group.id}/${model.id}/`) ? <Loader2 className="size-4 animate-spin" /> : selected && <Check className="size-4 text-brand" />}
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
          <button onClick={onOpenSettings} className="mt-1 flex w-full items-center justify-center gap-1.5 py-2 text-[13px] text-muted-foreground">
            <Plus className="size-4" />モデル・プロバイダーを追加
          </button>
        </div>
      </SheetContent>
    </Sheet>
  )
}

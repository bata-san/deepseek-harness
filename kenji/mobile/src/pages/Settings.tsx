import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink, KeyRound, Loader2, LogOut, Monitor, Moon, Plus, RefreshCw, Server, Sun, Trash2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { DEFAULT_SNIPPETS, useLocal } from '@/lib/app'
import { call, type Me } from '@/lib/dsh'
import { cn, vibrate } from '@/lib/utils'

type Configurable = {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: string[]
  declared: boolean
  defaultBaseURL?: string
  nativeAuth?: { env: string[]; oauth: boolean }
}
type Namespace = { ns: string; value: Record<string, unknown>; user: Record<string, unknown>; revision: number }

// よく使われるものを先頭に（特定ベンダーを既定にはしない）
const POPULAR = ['anthropic', 'openai', 'google', 'openrouter', 'xai', 'mistral', 'groq', 'deepseek', 'together', 'fireworks']

function envNameFor(provider: Configurable): string {
  const candidate = provider.nativeAuth?.env.find(name => /(_API_KEY|_TOKEN)$/.test(name) && !/OAUTH|IDENTITY|FEDERATION/.test(name))
  return candidate ?? `${provider.provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

async function readNamespace(ns: string): Promise<Namespace | undefined> {
  const value = await call<{ namespaces: Namespace[] }>('settings/describe')
  return value.namespaces.find(n => n.ns === ns)
}

async function mutate(ns: string, ops: { op: 'set' | 'unset'; path: string[]; value?: unknown }[]) {
  const current = await readNamespace(ns)
  await call('settings/mutate', { ns, ops, expectedRevision: current?.revision ?? 0 })
}

type ModelEntry = { id: string; name?: string; contextWindow?: number; reasoningEfforts?: Record<string, string | null> }
const STANDARD_EFFORTS: Record<string, string | null> = { off: null, low: 'low', medium: 'medium', high: 'high' }
type ProviderEntry = { apiKeyEnv?: string; baseURL?: string; displayName?: string; api?: string; models?: ModelEntry[] }
type Discovered = { id: string; name?: string; contextWindow?: number }

/** モデル一覧の取得・複数選択・手入力でプロバイダーにモデルを何個でも追加する */
function ModelPicker({ discover, initial, onChange }: {
  discover: () => Promise<Discovered[]>
  initial: ModelEntry[]
  onChange: (models: ModelEntry[]) => void
}) {
  const [found, setFound] = useState<Discovered[] | null>(null)
  const [chosen, setChosen] = useState<Map<string, ModelEntry>>(() => new Map(initial.map(m => [m.id, m])))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [manual, setManual] = useState('')
  const [filter, setFilter] = useState('')
  const [efforts, setEfforts] = useState(() => initial.some(m => m.reasoningEfforts))

  const emit = (next: Map<string, ModelEntry>, on: boolean) => {
    onChange([...next.values()].map(m => {
      const { reasoningEfforts: _drop, ...rest } = m
      void _drop
      return on ? { ...rest, reasoningEfforts: m.reasoningEfforts ?? STANDARD_EFFORTS } : rest
    }))
  }
  const update = (next: Map<string, ModelEntry>) => {
    setChosen(next)
    emit(next, efforts)
  }
  const fetchList = async () => {
    setBusy(true)
    setError('')
    try {
      const list = await discover()
      setFound(list)
      if (list.length === 0) setError('モデルが見つかりませんでした。下の欄に ID を直接入力できます。')
    } catch (e) {
      setError(`取得できませんでした: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }
  const toggle = (m: Discovered) => {
    const next = new Map(chosen)
    if (next.has(m.id)) next.delete(m.id)
    else next.set(m.id, { id: m.id, ...(m.name ? { name: m.name } : {}), ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) })
    update(next)
    vibrate(5)
  }
  const addManual = () => {
    const next = new Map(chosen)
    for (const raw of manual.split(/[\n,、\s]+/)) {
      const id = raw.trim()
      if (id) next.set(id, next.get(id) ?? { id })
    }
    update(next)
    setManual('')
  }
  const visible = (found ?? []).filter(m => !filter || m.id.toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="flex flex-col gap-2 rounded-xl border p-2.5">
      <div className="flex items-center gap-2">
        <span className="flex-1 text-xs font-medium text-muted-foreground">モデル（{chosen.size} 個）</span>
        <Button size="sm" variant="outline" onClick={() => void fetchList()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}一覧を取得
        </Button>
      </div>
      {chosen.size > 0 && (
        <div className="flex flex-wrap gap-1">
          {[...chosen.values()].map(m => (
            <span key={m.id} className="flex items-center gap-1 rounded-full bg-secondary py-0.5 pl-2.5 pr-1 text-xs">
              {m.id}
              <button aria-label={`${m.id} を外す`} onClick={() => { const n = new Map(chosen); n.delete(m.id); update(n) }} className="rounded-full p-0.5 text-muted-foreground"><X className="size-3" /></button>
            </span>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-muted-foreground">{error}</p>}
      {found && found.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <div className="flex gap-1.5">
            {found.length > 8 && <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="絞り込み" className="h-9 text-sm" />}
            <Button size="sm" variant="ghost" className="shrink-0" onClick={() => { const n = new Map(chosen); for (const m of visible) n.set(m.id, { id: m.id, ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}) }); update(n) }}>すべて選択</Button>
          </div>
          <div className="max-h-64 overflow-y-auto rounded-lg border">
            {visible.map(m => (
              <button key={m.id} onClick={() => toggle(m)} className="flex w-full items-center gap-2 border-b px-3 py-2 text-left text-[13px] last:border-b-0">
                <span className={cn('flex size-4 shrink-0 items-center justify-center rounded border', chosen.has(m.id) && 'border-primary bg-primary text-primary-foreground')}>
                  {chosen.has(m.id) && <Check className="size-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{m.name && m.name !== m.id ? `${m.name}（${m.id}）` : m.id}</span>
                {m.contextWindow ? <span className="shrink-0 text-[11px] text-muted-foreground">{Math.round(m.contextWindow / 1000)}k</span> : null}
              </button>
            ))}
          </div>
        </div>
      )}
      <label className="flex items-center gap-2 px-0.5 text-xs text-muted-foreground">
        <input type="checkbox" checked={efforts} onChange={e => { setEfforts(e.target.checked); emit(chosen, e.target.checked) }} className="size-4 accent-current" />
        思考レベル（オフ / low / medium / high）を切り替えられるようにする
      </label>
      <div className="flex gap-1.5">
        <Input value={manual} onChange={e => setManual(e.target.value)} placeholder="モデル ID を直接追加（複数はカンマ区切り）" className="h-9 text-sm" autoCapitalize="none"
          onKeyDown={e => { if (e.key === 'Enter') addManual() }} />
        <Button size="sm" variant="outline" className="h-9 shrink-0" disabled={!manual.trim()} onClick={addManual}><Plus /></Button>
      </div>
    </div>
  )
}

function ModelProviders() {
  const [providers, setProviders] = useState<Configurable[]>([])
  const [configured, setConfigured] = useState<Record<string, ProviderEntry>>({})
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [custom, setCustom] = useState({ name: '', baseURL: '' })
  const [models, setModels] = useState<ModelEntry[]>([])
  const [mode, setMode] = useState<'catalog' | 'custom'>('catalog')
  const [editing, setEditing] = useState<string | null>(null)
  const [editModels, setEditModels] = useState<ModelEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [defaultModel, setDefaultModel] = useState('')
  const [pickerKey, setPickerKey] = useState(0)

  const load = useCallback(async () => {
    try {
      const [list, ns, catalog] = await Promise.all([
        call<Configurable[]>('llm/listConfigurableProviders'),
        readNamespace('llm-pi-ai'),
        call<{ default: { provider: string; model: string }; routableProviders: string[] }>('session/modelCatalog'),
      ])
      setProviders(list.filter(p => p.settingsNs === 'llm-pi-ai'))
      const entries = (ns?.value?.providers ?? {}) as Record<string, ProviderEntry>
      setConfigured(entries)
      const refs = [...new Set(Object.values(entries).map(e => e.apiKeyEnv).filter((r): r is string => Boolean(r)))]
      if (refs.length) {
        const info = await call<Record<string, { configured: boolean }>>('credentials/describe', { refs })
        setKeyStatus(Object.fromEntries(Object.entries(info).map(([k, v]) => [k, v.configured])))
      }
      setDefaultModel(catalog.routableProviders.includes(catalog.default.provider) ? `${catalog.default.provider} / ${catalog.default.model}` : '')
    } catch (e) {
      setMessage((e as Error).message)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const ordered = useMemo(() => [...providers].sort((a, b) => {
    const ia = POPULAR.indexOf(a.provider), ib = POPULAR.indexOf(b.provider)
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib) || a.provider.localeCompare(b.provider)
  }), [providers])

  const discover = (request: Record<string, unknown>) => () =>
    call<Discovered[]>('llm/discoverModels', { settingsNs: 'llm-pi-ai', request })

  const finish = async (text: string) => {
    setApiKey('')
    setModels([])
    setPickerKey(k => k + 1)
    try { await call('session/initializeDefaultModel') } catch { /* モデル一覧の取得待ち */ }
    setMessage(text)
    await load()
  }

  const save = async () => {
    setBusy(true)
    setMessage('')
    vibrate()
    try {
      if (mode === 'catalog') {
        const provider = providers.find(p => p.provider === selected)
        if (!provider) throw new Error('プロバイダーを選んでください')
        const env = envNameFor(provider)
        if (apiKey.trim()) await call('credentials/set', { ref: env, value: apiKey.trim() })
        const prev = configured[provider.provider] ?? {}
        await mutate('llm-pi-ai', [{
          op: 'set', path: ['providers', provider.provider],
          value: { ...prev, apiKeyEnv: env, ...(models.length ? { models: mergeModels(prev.models, models) } : {}) },
        }])
      } else {
        const id = custom.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
        if (!id || !custom.baseURL.trim()) throw new Error('名前と Base URL を入力してください')
        if (models.length === 0) throw new Error('モデルを 1 つ以上選ぶか入力してください')
        const env = `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`
        if (apiKey.trim()) await call('credentials/set', { ref: env, value: apiKey.trim() })
        await mutate('llm-pi-ai', [{
          op: 'set', path: ['providers', id], value: {
            displayName: custom.name.trim(), apiKeyEnv: env, api: 'openai-completions', baseURL: custom.baseURL.trim(),
            models: models.map(m => ({ ...m, name: m.name ?? m.id })),
          },
        }])
        setCustom({ name: '', baseURL: '' })
      }
      await finish('保存しました')
    } catch (e) {
      setMessage(`保存できませんでした: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const saveModels = async (id: string) => {
    setBusy(true)
    try {
      const entry = configured[id] ?? {}
      const isCustom = Boolean(entry.baseURL && entry.api)
      await mutate('llm-pi-ai', editModels.length || !isCustom
        ? [{ op: editModels.length ? 'set' : 'unset', path: ['providers', id, 'models'], ...(editModels.length ? { value: editModels.map(m => ({ ...m, name: m.name ?? m.id })) } : {}) }]
        : [])
      setEditing(null)
      await finish('モデルを更新しました')
    } catch (e) {
      setMessage(`更新できませんでした: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (id: string) => {
    if (!confirm(`${id} の設定を削除しますか？`)) return
    setBusy(true)
    try {
      const env = configured[id]?.apiKeyEnv
      await mutate('llm-pi-ai', [{ op: 'unset', path: ['providers', id] }])
      if (env) await call('credentials/unset', { ref: env }).catch(() => undefined)
      await load()
    } catch (e) {
      setMessage((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const catalogProvider = providers.find(p => p.provider === selected)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" />AI モデル</CardTitle>
        <CardDescription>
          プロバイダーごとに API キーとモデルを登録します。1 つのプロバイダーにモデルをいくつでも追加できます。キーは PC 内の認証情報ストアにだけ保存されます。
          {defaultModel && <span className="mt-1 block">現在の既定: <span className="font-medium text-foreground">{defaultModel}</span></span>}
        </CardDescription>
      </CardHeader>
      <div className="flex flex-col gap-3 px-4 pb-4">
        {Object.keys(configured).length > 0 && (
          <div className="flex flex-col divide-y rounded-xl border">
            {Object.entries(configured).map(([id, entry]) => (
              <div key={id} className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <Server className="size-4 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{entry.displayName ?? id}</div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {entry.models?.length ? `モデル ${entry.models.length} 個` : '標準のモデル一覧'}{entry.baseURL ? ` · ${entry.baseURL}` : ''}
                    </div>
                  </div>
                  {entry.apiKeyEnv && (keyStatus[entry.apiKeyEnv]
                    ? <Badge variant="success"><Check className="size-3" />キー</Badge>
                    : <Badge variant="warning">キー未登録</Badge>)}
                  <button onClick={() => { setEditing(editing === id ? null : id); setEditModels(entry.models ?? []) }} className="rounded-md px-2 py-1 text-xs text-primary">モデル</button>
                  <button onClick={() => void remove(id)} disabled={busy} className="p-1.5 text-muted-foreground" aria-label="削除"><Trash2 className="size-4" /></button>
                </div>
                {editing === id && (
                  <div className="mt-2 flex flex-col gap-2">
                    <ModelPicker initial={entry.models ?? []} onChange={setEditModels}
                      discover={discover(entry.baseURL ? { baseURL: entry.baseURL, ...(entry.api ? { api: entry.api } : {}), provider: id } : { provider: id })} />
                    <Button size="sm" onClick={() => void saveModels(id)} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Check />}モデルを保存</Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-sm">
          {(['catalog', 'custom'] as const).map(m => (
            <button key={m} onClick={() => { setMode(m); setModels([]); setPickerKey(k => k + 1) }} className={cn('rounded-md py-1.5', mode === m ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground')}>
              {m === 'catalog' ? '一覧から選ぶ' : 'OpenAI 互換 / ローカル'}
            </button>
          ))}
        </div>

        {mode === 'catalog'
          ? (
            <select value={selected} onChange={e => { setSelected(e.target.value); setModels([]); setPickerKey(k => k + 1) }} className="h-11 rounded-lg border bg-card px-3 text-base">
              {ordered.map(p => <option key={p.provider} value={p.provider}>{p.displayName}{configured[p.provider] ? '（設定済み）' : ''}</option>)}
            </select>
          )
          : (
            <div className="flex flex-col gap-2">
              <Input placeholder="表示名（例: 社内ゲートウェイ / Ollama）" value={custom.name} onChange={e => setCustom({ ...custom, name: e.target.value })} />
              <Input placeholder="Base URL（例: http://127.0.0.1:11434/v1）" value={custom.baseURL} autoCapitalize="none" onChange={e => setCustom({ ...custom, baseURL: e.target.value })} />
            </div>
          )}
        <Input type="password" placeholder={mode === 'custom' ? 'API キー（不要なら空欄）' : 'API キー'} value={apiKey} autoComplete="off" onChange={e => setApiKey(e.target.value)} />
        <ModelPicker key={`${mode}-${selected}-${pickerKey}`} initial={[]} onChange={setModels}
          discover={mode === 'catalog'
            ? discover({ provider: selected, ...(catalogProvider?.defaultBaseURL ? { baseURL: catalogProvider.defaultBaseURL } : {}), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })
            : discover({ baseURL: custom.baseURL.trim(), api: 'openai-completions', ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) })} />
        {mode === 'catalog' && <p className="-mt-1 text-[11px] text-muted-foreground">モデルを選ばなければ、プロバイダーの標準モデル一覧がそのまま使えます。</p>}
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}保存
        </Button>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </div>
    </Card>
  )
}

function mergeModels(prev: ModelEntry[] | undefined, next: ModelEntry[]): ModelEntry[] {
  const map = new Map((prev ?? []).map(m => [m.id, m]))
  for (const m of next) map.set(m.id, { ...map.get(m.id), ...m, name: m.name ?? m.id })
  return [...map.values()]
}

function Snippets() {
  const [snippets, setSnippets] = useLocal<string[]>('kh.snippets', DEFAULT_SNIPPETS)
  const [draft, setDraft] = useState('')
  return (
    <Card>
      <CardHeader>
        <CardTitle>定型文</CardTitle>
        <CardDescription>入力欄の上にワンタップで送れる文を並べます。</CardDescription>
      </CardHeader>
      <div className="flex flex-col gap-2 px-4 pb-4">
        {snippets.map((s, i) => (
          <div key={`${s}-${i}`} className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm">
            <span className="flex-1">{s}</span>
            <button className="text-muted-foreground" aria-label="削除" onClick={() => setSnippets(snippets.filter((_, j) => j !== i))}><Trash2 className="size-4" /></button>
          </div>
        ))}
        <div className="flex gap-2">
          <Input value={draft} onChange={e => setDraft(e.target.value)} placeholder="定型文を追加" />
          <Button variant="outline" disabled={!draft.trim()} onClick={() => { setSnippets([...snippets, draft.trim()]); setDraft('') }}><Plus /></Button>
        </div>
        <button className="self-start text-xs text-muted-foreground underline" onClick={() => setSnippets(DEFAULT_SNIPPETS)}>初期状態に戻す</button>
      </div>
    </Card>
  )
}

function Theme() {
  const [theme, setTheme] = useLocal<string>('kh.theme', 'dark')
  const options = [
    { id: 'system', label: '自動', icon: Monitor },
    { id: 'light', label: 'ライト', icon: Sun },
    { id: 'dark', label: 'ダーク', icon: Moon },
  ]
  return (
    <Card className="p-4">
      <div className="mb-2 text-sm font-semibold">表示</div>
      <div className="grid grid-cols-3 gap-2">
        {options.map(o => (
          <button key={o.id} onClick={() => { setTheme(o.id); window.dispatchEvent(new Event('kh:theme')) }}
            className={cn('flex flex-col items-center gap-1 rounded-xl border py-2.5 text-xs', theme === o.id ? 'border-primary bg-primary/10 text-primary' : 'text-muted-foreground')}>
            <o.icon className="size-4" />{o.label}
          </button>
        ))}
      </div>
    </Card>
  )
}

export function Settings({ me, onLogout }: { me: Me; onLogout: () => void }) {
  return (
    <div className="scroll-touch h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-3 py-4">
        <ModelProviders />
        <Snippets />
        <Theme />
        <Card className="divide-y">
          <a href="./full/" target="_blank" rel="noreferrer" className="flex items-center gap-3 px-4 py-3 text-sm">
            <Monitor className="size-4 text-muted-foreground" /><span className="flex-1">PC 版の画面を開く</span><ExternalLink className="size-4 text-muted-foreground" />
          </a>
          <a href="../" className="flex items-center gap-3 px-4 py-3 text-sm">
            <Server className="size-4 text-muted-foreground" /><span className="flex-1">Kenji に戻る</span><ExternalLink className="size-4 text-muted-foreground" />
          </a>
          <button onClick={onLogout} className="flex w-full items-center gap-3 px-4 py-3 text-left text-sm text-destructive">
            <LogOut className="size-4" /><span className="flex-1">ログアウト（{me.username}）</span>
          </button>
        </Card>
        <p className="pb-4 text-center text-[11px] text-muted-foreground">Kenji Harness · {me.role}{me.workspace ? ` · ${me.workspace}` : ''}</p>
      </div>
    </div>
  )
}

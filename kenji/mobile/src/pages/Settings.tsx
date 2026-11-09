import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, ExternalLink, KeyRound, Loader2, LogOut, Monitor, Moon, Plus, Server, Sun, Trash2 } from 'lucide-react'
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

function ModelProviders() {
  const [providers, setProviders] = useState<Configurable[]>([])
  const [configured, setConfigured] = useState<Record<string, { apiKeyEnv?: string; baseURL?: string; displayName?: string }>>({})
  const [keyStatus, setKeyStatus] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState('anthropic')
  const [apiKey, setApiKey] = useState('')
  const [custom, setCustom] = useState({ name: '', baseURL: '', model: '' })
  const [mode, setMode] = useState<'catalog' | 'custom'>('catalog')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [defaultModel, setDefaultModel] = useState('')

  const load = useCallback(async () => {
    try {
      const [list, ns, catalog] = await Promise.all([
        call<Configurable[]>('llm/listConfigurableProviders'),
        readNamespace('llm-pi-ai'),
        call<{ default: { provider: string; model: string }; routableProviders: string[] }>('session/modelCatalog'),
      ])
      setProviders(list.filter(p => p.settingsNs === 'llm-pi-ai'))
      const entries = (ns?.value?.providers ?? {}) as Record<string, { apiKeyEnv?: string; baseURL?: string; displayName?: string }>
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
        await mutate('llm-pi-ai', [{ op: 'set', path: ['providers', provider.provider], value: { apiKeyEnv: env } }])
      } else {
        const id = custom.name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '')
        if (!id || !custom.baseURL.trim() || !custom.model.trim()) throw new Error('名前・URL・モデル ID を入力してください')
        const env = `${id.toUpperCase().replace(/-/g, '_')}_API_KEY`
        if (apiKey.trim()) await call('credentials/set', { ref: env, value: apiKey.trim() })
        await mutate('llm-pi-ai', [{
          op: 'set', path: ['providers', id], value: {
            displayName: custom.name.trim(), apiKeyEnv: env, api: 'openai-completions', baseURL: custom.baseURL.trim(),
            models: [{ id: custom.model.trim(), name: custom.model.trim() }],
          },
        }])
      }
      setApiKey('')
      // 既定モデルが使えない状態なら、使えるモデルを自動で選ぶ
      try { await call('session/initializeDefaultModel') } catch { /* モデル一覧の取得待ち */ }
      setMessage('保存しました')
      await load()
    } catch (e) {
      setMessage(`保存できませんでした: ${(e as Error).message}`)
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><KeyRound className="size-4" />AI モデル</CardTitle>
        <CardDescription>
          使いたいプロバイダーの API キーを登録します。キーは PC 内のハーネスの認証情報ストアにだけ保存されます。
          {defaultModel && <span className="mt-1 block">現在の既定: <span className="font-medium text-foreground">{defaultModel}</span></span>}
        </CardDescription>
      </CardHeader>
      <div className="flex flex-col gap-3 px-4 pb-4">
        {Object.keys(configured).length > 0 && (
          <div className="flex flex-col divide-y rounded-xl border">
            {Object.entries(configured).map(([id, entry]) => (
              <div key={id} className="flex items-center gap-2 px-3 py-2">
                <Server className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium">{entry.displayName ?? id}</div>
                  {entry.baseURL && <div className="truncate text-[11px] text-muted-foreground">{entry.baseURL}</div>}
                </div>
                {entry.apiKeyEnv && (keyStatus[entry.apiKeyEnv]
                  ? <Badge variant="success"><Check className="size-3" />キー登録済み</Badge>
                  : <Badge variant="warning">キー未登録</Badge>)}
                <button onClick={() => void remove(id)} disabled={busy} className="p-1.5 text-muted-foreground" aria-label="削除"><Trash2 className="size-4" /></button>
              </div>
            ))}
          </div>
        )}

        <div className="grid grid-cols-2 gap-1 rounded-lg bg-muted p-1 text-sm">
          {(['catalog', 'custom'] as const).map(m => (
            <button key={m} onClick={() => setMode(m)} className={cn('rounded-md py-1.5', mode === m ? 'bg-card font-medium shadow-sm' : 'text-muted-foreground')}>
              {m === 'catalog' ? '一覧から選ぶ' : 'OpenAI 互換 / ローカル'}
            </button>
          ))}
        </div>

        {mode === 'catalog'
          ? (
            <select value={selected} onChange={e => setSelected(e.target.value)} className="h-11 rounded-lg border bg-card px-3 text-base">
              {ordered.map(p => <option key={p.provider} value={p.provider}>{p.displayName}{configured[p.provider] ? '（設定済み）' : ''}</option>)}
            </select>
          )
          : (
            <div className="flex flex-col gap-2">
              <Input placeholder="表示名（例: 社内ゲートウェイ / Ollama）" value={custom.name} onChange={e => setCustom({ ...custom, name: e.target.value })} />
              <Input placeholder="Base URL（例: http://127.0.0.1:11434/v1）" value={custom.baseURL} autoCapitalize="none" onChange={e => setCustom({ ...custom, baseURL: e.target.value })} />
              <Input placeholder="モデル ID" value={custom.model} autoCapitalize="none" onChange={e => setCustom({ ...custom, model: e.target.value })} />
            </div>
          )}
        <Input type="password" placeholder={mode === 'custom' ? 'API キー（不要なら空欄）' : 'API キー'} value={apiKey} autoComplete="off" onChange={e => setApiKey(e.target.value)} />
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Plus />}保存
        </Button>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </div>
    </Card>
  )
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

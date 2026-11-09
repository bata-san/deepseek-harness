import { useCallback, useEffect, useMemo, useState } from 'react'
import { ChevronRight, Download, Loader2, Package, PackageCheck, RefreshCw, Search, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { call, newId } from '@/lib/dsh'
import { cn, vibrate } from '@/lib/utils'

type Localized = string | Record<string, string> | undefined
type Bundle = {
  name: string
  official: boolean
  version?: string
  description?: string
  meta?: { title?: Localized; description?: Localized }
  enabled: boolean
  installed: boolean
  optional: boolean
  removable: boolean
  readOnlyReason?: string
  listedByDefault?: boolean
  availability?: string
  error?: { code: string }
  rows?: { rowId: string; moduleName: string; entryId: string; meta?: { title?: Localized; description?: Localized } }[]
}
type Plugin = { entryId: string; moduleName: string; enabled: boolean; fiberPhase: string | null; patchId?: string; readOnlyReason?: string; meta?: { title?: Localized; description?: Localized } }
type ChangeResult = { status?: string; restartRequired?: boolean; [key: string]: unknown }

function loc(value: Localized): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  return value.ja ?? value.en ?? Object.values(value)[0] ?? ''
}

function bundleTitle(bundle: Bundle): string {
  const title = loc(bundle.meta?.title)
  if (title && title !== bundle.name) return title
  return bundle.name.replace(/^@deepseek-ai\/dsh-(experimental-)?/, '').replace(/-bundle$/, '').replace(/-/g, ' ')
}

// 中身のコア（読み取り専用）バンドルは一覧に出さない
const CORE = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-acp-app', '@deepseek-ai/dsh-headless', '@deepseek-ai/dsh-sdk-app', '@deepseek-ai/dsh-sdk-minimal'])

export function Plugins() {
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [plugins, setPlugins] = useState<Plugin[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [spec, setSpec] = useState('')
  const [filter, setFilter] = useState('')
  const [showAdvanced, setShowAdvanced] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [b, p] = await Promise.all([call<Bundle[]>('pluginManager/listBundles'), call<Plugin[]>('pluginManager/listPlugins')])
      setBundles(b)
      setPlugins(p)
      setError('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { void load() }, [load])

  const report = (result: ChangeResult | null | undefined, ok: string) => {
    const restart = result && (result.restartRequired === true || result.status === 'restart-required' || JSON.stringify(result).includes('restart-required'))
    setNotice(restart ? `${ok}（反映にはハーネスの再起動が必要です）` : ok)
    window.setTimeout(() => setNotice(''), 5000)
  }

  const run = async (key: string, action: () => Promise<ChangeResult | null>, ok: string) => {
    setBusy(key)
    vibrate()
    try {
      report(await action(), ok)
      await load()
    } catch (e) {
      setNotice(`失敗しました: ${(e as Error).message}`)
    } finally {
      setBusy(null)
    }
  }

  const install = async () => {
    const value = spec.trim()
    if (!value) return
    await run('install', async () => {
      const requestId = newId()
      const result = await call<ChangeResult>('pluginManager/installBundle', { spec: value, options: { requestId } })
      setSpec('')
      return result
    }, `${value} をインストールしました`)
  }

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return bundles
      .filter(b => !CORE.has(b.name) && b.listedByDefault !== false || b.installed || b.enabled && !CORE.has(b.name))
      .filter(b => !q || b.name.toLowerCase().includes(q) || bundleTitle(b).toLowerCase().includes(q) || loc(b.meta?.description).toLowerCase().includes(q))
      .sort((a, b) => Number(b.enabled) - Number(a.enabled) || Number(b.installed) - Number(a.installed) || bundleTitle(a).localeCompare(bundleTitle(b), 'ja'))
  }, [bundles, filter])

  const toggleable = useMemo(() => plugins.filter(p => p.patchId && !p.readOnlyReason), [plugins])

  return (
    <div className="scroll-touch h-full overflow-y-auto">
      <div className="mx-auto flex max-w-2xl flex-col gap-4 px-3 py-4">
        <Card className="p-3">
          <div className="mb-2 flex items-center gap-2 text-sm font-semibold"><Download className="size-4" />プラグインを追加</div>
          <p className="mb-2 text-xs text-muted-foreground">npm パッケージ名（例: <code>dsh-plugin-foo</code>、<code>@scope/bundle@1.2.0</code>）や GitHub の指定を入力します。</p>
          <div className="flex gap-2">
            <Input value={spec} onChange={e => setSpec(e.target.value)} placeholder="パッケージ名" autoCapitalize="none" autoCorrect="off"
              onKeyDown={e => { if (e.key === 'Enter') void install() }} />
            <Button onClick={() => void install()} disabled={!spec.trim() || busy !== null} className="shrink-0">
              {busy === 'install' ? <Loader2 className="animate-spin" /> : <Download />}追加
            </Button>
          </div>
          <a className="mt-2 inline-block text-xs text-primary underline underline-offset-2" href="https://github.com/topics/dsh-plugin" target="_blank" rel="noreferrer">
            dsh-plugin のプラグインを探す
          </a>
        </Card>

        {notice && <div className="rounded-xl bg-primary/10 px-3 py-2 text-sm text-primary">{notice}</div>}
        {error && <div className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={filter} onChange={e => setFilter(e.target.value)} placeholder="絞り込み" className="h-10 pl-9" />
          </div>
          <Button variant="outline" size="icon" onClick={() => void load()} aria-label="再読み込み">
            <RefreshCw className={cn(loading && 'animate-spin')} />
          </Button>
        </div>

        <div className="flex flex-col gap-2">
          {visible.map(bundle => (
            <Card key={bundle.name} className="p-3">
              <div className="flex items-start gap-3">
                <div className={cn('mt-0.5 rounded-lg p-2', bundle.enabled ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground')}>
                  {bundle.enabled ? <PackageCheck className="size-4" /> : <Package className="size-4" />}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-sm font-medium">{bundleTitle(bundle)}</span>
                    {bundle.name.includes('experimental') && <Badge variant="warning">実験的</Badge>}
                    {bundle.installed && <Badge variant="secondary">追加済み</Badge>}
                    {bundle.error && <Badge variant="destructive">{bundle.error.code === 'unsupported-platform' ? 'この OS 非対応' : bundle.error.code}</Badge>}
                  </div>
                  {loc(bundle.meta?.description ?? bundle.description) && (
                    <p className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{loc(bundle.meta?.description ?? bundle.description)}</p>
                  )}
                  <div className="mt-1 truncate font-mono text-[10px] text-muted-foreground/80">{bundle.name}{bundle.version ? `@${bundle.version}` : ''}</div>
                </div>
                <div className="flex flex-col items-end gap-2">
                  {busy === bundle.name
                    ? <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    : <Switch checked={bundle.enabled} disabled={busy !== null || Boolean(bundle.readOnlyReason) || Boolean(bundle.error)}
                        onCheckedChange={(on) => void run(bundle.name, () => call<ChangeResult>('pluginManager/setBundleEnabled', { name: bundle.name, enabled: on }), on ? '有効にしました' : '無効にしました')} />}
                  {bundle.removable && (
                    <button disabled={busy !== null} className="p-1 text-muted-foreground" aria-label="削除"
                      onClick={() => { if (confirm(`${bundle.name} を削除しますか？`)) void run(bundle.name, () => call<ChangeResult>('pluginManager/removeBundle', { name: bundle.name }), '削除しました') }}>
                      <Trash2 className="size-4" />
                    </button>
                  )}
                </div>
              </div>
            </Card>
          ))}
          {!loading && visible.length === 0 && <div className="py-8 text-center text-sm text-muted-foreground">該当するプラグインはありません</div>}
        </div>

        <div>
          <button onClick={() => setShowAdvanced(!showAdvanced)} className="flex w-full items-center gap-2 py-2 text-sm font-medium text-muted-foreground">
            <ChevronRight className={cn('size-4 transition-transform', showAdvanced && 'rotate-90')} />
            個別の機能（{toggleable.length}）
          </button>
          {showAdvanced && (
            <Card className="divide-y">
              {toggleable.map(plugin => (
                <div key={plugin.entryId} className="flex items-center gap-3 px-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">{loc(plugin.meta?.title) || plugin.patchId}</div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">{plugin.moduleName}</div>
                  </div>
                  {busy === plugin.entryId
                    ? <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    : <Switch checked={plugin.enabled} disabled={busy !== null}
                        onCheckedChange={(on) => void run(plugin.entryId, () => call<ChangeResult>('pluginManager/setPluginEnabled', { id: plugin.entryId, enabled: on }), on ? '有効にしました' : '無効にしました')} />}
                </div>
              ))}
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}

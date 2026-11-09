import { useEffect, useState } from 'react'
import { Check, ClipboardList, Loader2, ShieldAlert } from 'lucide-react'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { call } from '@/lib/dsh'
import { cn, vibrate } from '@/lib/utils'

export const MODE_LABELS: Record<string, { name: string; short: string; description: string }> = {
  standard: { name: '標準モード', short: '標準', description: 'コード・ファイル・情報を扱う普段使いのモード。検索、編集、ターミナルなどを必要に応じて使います。' },
  ptc: { name: 'PTC モード', short: 'PTC', description: '標準の機能に加えて、ツールをまとめて呼び出し、結果の絞り込み・集計・要約をするタスクに向いています。' },
  minimal: { name: '最小モード', short: '最小', description: 'ターミナルと画像の読み取りだけを使う軽量なモード。基本性能の確認向けです。' },
  cordis: { name: 'クリエイターモード', short: 'クリエイター', description: '会話しながらハーネス自体を拡張します。機能や UI を追加するプラグイン、独自のモードを作れます。' },
}

export const PERMISSION_LABELS: Record<string, { name: string; short: string; description: string; danger?: boolean }> = {
  'read-only': { name: '読み取りのみ', short: '読取', description: 'ファイルの変更やコマンドによる書き込みはできません。調査やレビュー向けです。' },
  'workspace-write': { name: 'ワークスペース内の書き込み', short: '書込', description: '作業フォルダーの中だけ変更できます。外への書き込みは承認が必要です。' },
  'danger-full-access': { name: 'フルアクセス', short: 'フル', description: 'サンドボックスなしで PC 全体を読み書きできます。信頼できる作業でだけ使ってください。', danger: true },
}

export function modeName(id: string | undefined): string {
  return id ? (MODE_LABELS[id]?.short ?? id) : '標準'
}

type Preset = { id: string; order: number; isDefault: boolean; name?: string; description?: string }

export function ModeSheet({ open, onOpenChange, sessionId, mode, permission, planActive, onDefaults }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessionId: string | null
  mode?: string
  permission?: string
  planActive: boolean
  onDefaults: (next: { mode?: string; permission?: string }) => void
}) {
  const [presets, setPresets] = useState<Preset[]>([])
  const [permissions, setPermissions] = useState<string[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    call<{ presets: Preset[] }>('agentPresets/list').then(v => setPresets([...v.presets].sort((a, b) => a.order - b.order))).catch(e => setError((e as Error).message))
    call<{ options: { value: string }[] }>('permissionPresets/catalog').then(v => setPermissions(v.options.map(o => o.value))).catch(e => setError((e as Error).message))
  }, [open])

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key)
    setError('')
    vibrate()
    try {
      await action()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const command = (line: string) => {
    if (!sessionId) throw new Error('先にセッションを開始してください')
    return call('commands/execute', { agentId: sessionId, line, submittedAttachments: [] })
  }

  const selectMode = (id: string) => run(`mode:${id}`, async () => {
    onDefaults({ mode: id })
    if (sessionId) await call('agentPresets/select', { agentId: sessionId, agentPreset: id })
  })

  const selectPermission = (id: string) => {
    if (PERMISSION_LABELS[id]?.danger && !confirm('フルアクセスにすると、エージェントがサンドボックスなしで PC 全体を変更できます。続けますか？')) return
    void run(`perm:${id}`, async () => {
      onDefaults({ permission: id })
      if (sessionId) await command(`/permission ${id}`)
    })
  }

  const row = 'flex w-full items-start gap-3 border-b px-4 py-3 text-left last:border-b-0 active:bg-accent'
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent title="モードと権限" description={sessionId ? 'このセッションと、次の新規セッションに使われます' : '次の新規セッションに使われます'}>
        <div className="scroll-touch min-h-0 overflow-y-auto px-3 pb-6">
          {error && <p className="mb-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}

          <div className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">モード</div>
          <div className="mb-4 overflow-hidden rounded-2xl bg-card">
            {presets.map(p => {
              const label = MODE_LABELS[p.id]
              const active = (mode ?? presets.find(x => x.isDefault)?.id) === p.id
              return (
                <button key={p.id} className={row} onClick={() => void selectMode(p.id)}>
                  <div className="min-w-0 flex-1">
                    <div className="text-[14px] font-medium">{label?.name ?? p.name ?? p.id}</div>
                    <div className="text-[12px] leading-relaxed text-muted-foreground">{label?.description ?? p.description ?? ''}</div>
                  </div>
                  {busy === `mode:${p.id}` ? <Loader2 className="mt-1 size-4 animate-spin" /> : active && <Check className="mt-1 size-4 text-brand" />}
                </button>
              )
            })}
            {presets.length === 0 && <div className="flex justify-center py-6"><Loader2 className="animate-spin text-muted-foreground" /></div>}
          </div>

          <div className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">権限</div>
          <div className="mb-4 overflow-hidden rounded-2xl bg-card">
            {permissions.map(id => {
              const label = PERMISSION_LABELS[id]
              const active = permission === id
              return (
                <button key={id} className={row} onClick={() => selectPermission(id)}>
                  {label?.danger && <ShieldAlert className="mt-0.5 size-4 shrink-0 text-destructive" />}
                  <div className="min-w-0 flex-1">
                    <div className={cn('text-[14px] font-medium', label?.danger && 'text-destructive')}>{label?.name ?? id}</div>
                    <div className="text-[12px] leading-relaxed text-muted-foreground">{label?.description ?? ''}</div>
                  </div>
                  {busy === `perm:${id}` ? <Loader2 className="mt-1 size-4 animate-spin" /> : active && <Check className="mt-1 size-4 text-brand" />}
                </button>
              )
            })}
          </div>

          <div className="flex items-center gap-3 rounded-2xl bg-card px-4 py-3">
            <ClipboardList className="size-4 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-[14px] font-medium">プランモード</div>
              <div className="text-[12px] text-muted-foreground">実装の前に計画を立て、承認してから作業します。</div>
            </div>
            {busy === 'plan' ? <Loader2 className="size-4 animate-spin" />
              : <Switch checked={planActive} disabled={!sessionId} onCheckedChange={(on) => void run('plan', () => command(on ? '/plan' : '/plan off'))} />}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}

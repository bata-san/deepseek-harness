import { useState } from 'react'
import { Loader2, LogIn } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { login, type Me } from '@/lib/dsh'

export function Login({ onLogin }: { onLogin: (me: Me) => void }) {
  const [username, setUsername] = useState(() => localStorage.getItem('kh.lastUser') ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const me = await login(username.trim(), password)
      try { localStorage.setItem('kh.lastUser', username.trim()) } catch { /* ignore */ }
      onLogin(me)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full flex-col items-center justify-center px-6 pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)]">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <img src="./icon.svg" alt="" className="size-14 rounded-2xl shadow-sm" />
          <div>
            <h1 className="text-xl font-semibold">Harness</h1>
            <p className="mt-1 text-sm text-muted-foreground">Kenji のアカウントでログインしてください</p>
          </div>
        </div>
        <form onSubmit={submit} className="flex flex-col gap-3">
          <Input autoComplete="username" autoCapitalize="none" autoCorrect="off" placeholder="ユーザー名" value={username}
            onChange={e => setUsername(e.target.value)} required />
          <Input type="password" autoComplete="current-password" placeholder="パスワード" value={password}
            onChange={e => setPassword(e.target.value)} required />
          {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button type="submit" size="lg" disabled={busy || !username || !password} className="mt-1">
            {busy ? <Loader2 className="animate-spin" /> : <LogIn />}
            ログイン
          </Button>
        </form>
        <p className="mt-6 text-center text-xs text-muted-foreground">operator 以上の権限が必要です</p>
      </div>
    </div>
  )
}

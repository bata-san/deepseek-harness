// アプリ全体の状態: 接続、セッション一覧、承認・質問待ち
import { useCallback, useEffect, useRef, useState } from 'react'
import { answerWaterfall, call, mux, subscribeEvents, type ConnectionState, type PendingWaterfall } from './dsh'

export type SessionSummary = {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  origin?: 'subagent'
  parentSessionId?: string
  projections?: { values?: { title?: string | null } }
}

export type ApprovalRequest = PendingWaterfall & {
  request: { toolName?: string; callId?: string; reason?: string; displayReason?: Record<string, string> }
}
export type QuestionRequest = PendingWaterfall & {
  request: { questions?: { id: string; question: string; detail?: string; header?: string; options?: { label: string; description?: string }[]; multiSelect?: boolean }[] }
}

export function titleOf(session: SessionSummary | undefined): string {
  const title = session?.projections?.values?.title
  return title && title.trim() ? title : '新しいチャット'
}

export function useConnection(): ConnectionState {
  const [state, setState] = useState<ConnectionState>(mux.state)
  useEffect(() => mux.onState(setState), [])
  return state
}

export function useSessions(enabled: boolean) {
  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)

  const refresh = useCallback(async () => {
    if (inflight.current) return
    inflight.current = true
    setLoading(true)
    try {
      const value = await call<{ items: SessionSummary[] }>('session/list', { _request: {} })
      const items = value.items.filter(item => item.origin !== 'subagent').sort((a, b) => b.updatedAt - a.updatedAt)
      setSessions(items)
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      inflight.current = false
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!enabled) return
    void refresh()
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 8000)
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [enabled, refresh])

  return { sessions, loading, error, refresh }
}

/** 承認・質問の waterfall を受け取って保持する */
export function useInteractions(enabled: boolean) {
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [questions, setQuestions] = useState<QuestionRequest[]>([])
  const [home, setHome] = useState('')

  useEffect(() => {
    if (!enabled) return
    return subscribeEvents({
      onReady: (h) => {
        setHome(h)
        setApprovals([])
        setQuestions([])
      },
      onWaterfall: (pending) => {
        if (pending.event === 'approval/request') {
          setApprovals(list => [...list.filter(a => a.eventId !== pending.eventId), pending as ApprovalRequest])
          notify('承認が必要です', String((pending.request as { toolName?: string }).toolName ?? 'ツールの実行'))
        } else if (pending.event === 'user-questions/request') {
          setQuestions(list => [...list.filter(q => q.eventId !== pending.eventId), pending as QuestionRequest])
          notify('質問が届きました', 'エージェントが回答を待っています')
        } else {
          // 対応していないイベントは他の応答者へ回す
          void answerWaterfall(pending, { kind: 'next' }).catch(() => undefined)
        }
      },
      onCancel: (eventId) => {
        setApprovals(list => list.filter(a => a.eventId !== eventId))
        setQuestions(list => list.filter(q => q.eventId !== eventId))
      },
    })
  }, [enabled])

  const resolveApproval = useCallback(async (approval: ApprovalRequest, outcome: 'allowed-once' | 'rejected') => {
    setApprovals(list => list.filter(a => a.eventId !== approval.eventId))
    await answerWaterfall(approval, { kind: 'result', value: outcome })
  }, [])

  const answerQuestion = useCallback(async (question: QuestionRequest, answers: { id: string; selected: string[]; custom?: string }[]) => {
    setQuestions(list => list.filter(q => q.eventId !== question.eventId))
    await answerWaterfall(question, { kind: 'result', value: { answers } })
  }, [])

  return { approvals, questions, home, resolveApproval, answerQuestion }
}

let notifyPermissionAsked = false
function notify(title: string, body: string) {
  try {
    navigator.vibrate?.([30, 40, 30])
    if (document.visibilityState === 'visible' || !('Notification' in window)) return
    if (Notification.permission === 'granted') new Notification(title, { body, tag: 'kh-interaction' })
    else if (Notification.permission === 'default' && !notifyPermissionAsked) {
      notifyPermissionAsked = true
      void Notification.requestPermission()
    }
  } catch { /* 通知非対応 */ }
}

// ---------------------------------------------------------------------------
// 端末に保存する小さな設定
// ---------------------------------------------------------------------------
export function useLocal<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? fallback : JSON.parse(raw) as T
    } catch {
      return fallback
    }
  })
  const save = useCallback((next: T) => {
    setValue(next)
    try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* ignore */ }
  }, [key])
  return [value, save]
}

export const DEFAULT_SNIPPETS = [
  '続けてください',
  '変更内容を要約して',
  'テストを実行して結果を教えて',
  'エラーの原因を調べて修正して',
  '今の作業を git commit して',
]

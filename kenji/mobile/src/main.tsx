import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import './index.css'

// 端末のダーク/ライト設定に追従（設定画面で固定も可能）
function applyTheme() {
  let pref = 'system'
  try { pref = localStorage.getItem('kh.theme') ?? 'system' } catch { /* ignore */ }
  const dark = pref === 'dark' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.documentElement.classList.toggle('dark', dark)
}
applyTheme()
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme)
window.addEventListener('kh:theme', applyTheme)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

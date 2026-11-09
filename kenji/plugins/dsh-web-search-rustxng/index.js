/**
 * dsh-web-search-rustxng: a `web_search` provider backed by a self-hosted RustXNG
 * (SearXNG-compatible) instance. Registers into the `ctx.web` seam; no API key needed.
 * Plain ESM with no imports so it installs as a standalone dsh plugin bundle.
 */

export const name = 'web-search-rustxng'
export const inject = ['web']

const PROVIDER_ID = 'rustxng'

function normalizeBase(url) {
  const value = String(url || 'http://127.0.0.1:29483').trim()
  return value.endsWith('/') ? value : `${value}/`
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function apply(ctx, config = {}) {
  const base = normalizeBase(config.baseURL)
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 20000
  const engines = text(config.engines)
  const language = text(config.language)

  ctx.web.registerSearchProvider({
    id: PROVIDER_ID,
    title: 'RustXNG',
    description: {
      en: 'Self-hosted RustXNG metasearch. Free, no API key; results come from public search engines.',
      ja: '自前でホストした RustXNG のメタ検索です。無料・API キー不要で、公開検索エンジンの結果を集めます。',
    },
    available: () => true,
    async search(request, signal) {
      const url = new URL('search', base)
      url.searchParams.set('q', request.query)
      url.searchParams.set('format', 'json')
      if (request.maxResults) url.searchParams.set('max_results', String(request.maxResults))
      if (engines) url.searchParams.set('engines', engines)
      if (language) url.searchParams.set('language', language)
      const timeout = AbortSignal.timeout(timeoutMs)
      const response = await fetch(url, {
        headers: { accept: 'application/json' },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (!response.ok) {
        throw new Error(`RustXNG search failed: HTTP ${response.status} ${response.statusText}`)
      }
      const body = await response.json()
      const results = Array.isArray(body?.results) ? body.results : []
      const sources = []
      for (const item of results) {
        const link = text(item?.url) ?? text(item?.link)
        if (!link) continue
        const snippet = text(item.content) ?? text(item.snippet) ?? text(item.description)
        const publishedAt = text(item.publishedDate) ?? text(item.published_at) ?? text(item.publishedAt)
        sources.push({
          url: link,
          ...(text(item.title) ? { title: text(item.title) } : {}),
          ...(snippet ? { snippet } : {}),
          ...(text(item.raw_content) ? { summary: text(item.raw_content) } : {}),
          ...(publishedAt ? { publishedAt } : {}),
        })
        if (request.maxResults && sources.length >= request.maxResults) break
      }
      const answers = Array.isArray(body?.answers)
        ? body.answers.map(a => (typeof a === 'string' ? a : text(a?.answer) ?? text(a?.content))).filter(Boolean)
        : []
      return {
        ...(answers.length ? { content: answers.join('\n') } : {}),
        sources,
        truncated: false,
      }
    },
  })
}

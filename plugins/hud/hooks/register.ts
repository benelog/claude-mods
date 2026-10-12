import type { Register, SessionRateLimit, TurnUsage } from 'claude-code'

type Ttl = '5m' | '1h'

// One main-thread model request, as its response's usage reported it.
type Step = {
  at: number
  model: string
  read: number
  written: number
  prompt: number
}

type Cache = {
  ttl: Ttl
  // Whether a request has shown the TTL, rather than the plan suggesting it.
  isTtlKnown: boolean
  last?: Step
  verdict?: string
}

type Shown = {
  account?: string
  model?: string
  effort?: string
  contextPercent?: number
  limits: SessionRateLimit[]
  cache: Cache
}

const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }
const TTL_MS: Record<Ttl, number> = { '5m': 5 * 60_000, '1h': 60 * 60_000 }

// The effort a session starts at: the model's own effortLevel in modelSettings, else the global one.
function effortFromSettings(settings: Readonly<Record<string, unknown>>, model: string): string | undefined {
  const byModel = settings.modelSettings as Record<string, { effortLevel?: unknown } | undefined> | undefined
  const level = byModel?.[model]?.effortLevel ?? settings.effortLevel
  return typeof level === 'string' || typeof level === 'number' ? String(level) : undefined
}

// The plan and organization the account signed in with, as ~/.claude.json's oauthAccount records them.
function accountFromConfig(text: string): { label?: string; isSubscription: boolean } {
  const account = (JSON.parse(text) as { oauthAccount?: Record<string, unknown> }).oauthAccount
  if (!account) return { isSubscription: false }
  const type = typeof account.organizationType === 'string' ? account.organizationType : undefined
  const tier = typeof account.organizationRateLimitTier === 'string' ? account.organizationRateLimitTier : ''
  const multiplier = /_(\d+x)$/.exec(tier)?.[1]
  const plan = type?.replace(/^claude_/, '').replace(/^./, c => c.toUpperCase())
  const name = typeof account.organizationName === 'string' ? account.organizationName : undefined
  // A personal plan's organization is the one created with the account, named after its email.
  const org = name?.endsWith("'s Organization") ? 'personal' : name
  const role = typeof account.organizationRole === 'string' ? account.organizationRole : undefined
  const parts = [
    plan ? `${plan}${multiplier ? ` ${multiplier}` : ''}` : undefined,
    org ? `${org}${role ? ` (${role})` : ''}` : undefined,
  ].filter(Boolean)
  return {
    label: parts.length ? parts.join(' · ') : undefined,
    isSubscription: /^claude_(pro|max|team|enterprise)$/.test(type ?? ''),
  }
}

function stepOf(usage: TurnUsage, at: number): Step {
  const read = usage.cache_read_input_tokens
  const written = usage.cache_creation_input_tokens
  return { at, model: usage.model, read, written, prompt: usage.input_tokens + read + written }
}

// Whether a request reused the prefix the one before it cached, why not when it did not, and what that shows of the TTL.
function judgeCache(cache: Cache, step: Step): Cache {
  const prev = cache.last
  const hitPercent = step.prompt ? Math.round((step.read / step.prompt) * 100) : 0
  if (!prev) {
    return { ...cache, last: step, verdict: step.read ? `✓ ${hitPercent}%` : 'new' }
  }
  const gap = step.at - prev.at
  const isReused = step.read >= 0.5 * (prev.read + prev.written)
  if (isReused) {
    // A prefix read back after more than five minutes idle can only have lived on a one-hour TTL.
    const learned = gap > TTL_MS['5m'] ? { ttl: '1h' as const, isTtlKnown: true } : {}
    return { ...cache, ...learned, last: step, verdict: `✓ ${hitPercent}%` }
  }
  if (step.model !== prev.model) return { ...cache, last: step, verdict: '✗ model changed' }
  if (step.prompt < 0.5 * prev.prompt) return { ...cache, last: step, verdict: '✗ compacted' }
  if (gap > TTL_MS[cache.ttl]) return { ...cache, last: step, verdict: '✗ expired' }
  // A miss inside the hour after more than five minutes idle points to a five-minute TTL.
  if (gap > TTL_MS['5m']) return { ...cache, ttl: '5m', isTtlKnown: true, last: step, verdict: '✗ expired' }
  return { ...cache, last: step, verdict: '✗ broken' }
}

function statusText(s: Shown): string | undefined {
  const ttl = `ttl ${s.cache.ttl}${s.cache.isTtlKnown ? '' : '?'}`
  const parts = [
    s.account,
    s.model ? `${s.model}${s.effort ? ` (${s.effort})` : ''}` : undefined,
    s.contextPercent === undefined ? undefined : `ctx ${s.contextPercent}%`,
    s.cache.verdict ? `cache ${s.cache.verdict} · ${ttl}` : `cache ${ttl}`,
    s.limits.length ? s.limits.map(l => `${LIMIT_LABELS[l.kind] ?? l.kind} ${l.percentUsed}%`).join(' · ') : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(' │ ') : undefined
}

export const register: Register = on => {
  const shown: Shown = { limits: [], cache: { ttl: '5m', isTtlKnown: false } }
  let expiry: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const usage = await $.session.usage()
    shown.model = await $.session.model()
    shown.effort ??= effortFromSettings(await $.settings.read(), shown.model)
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await $.env.get('HOME'))
    const account = await $.fs
      .read(`${configDir}/.claude.json`)
      .then(accountFromConfig)
      .catch(() => ({ label: undefined, isSubscription: false }))
    shown.account = account.label
    // A new conversation starts a new prefix; until a request shows the TTL, the plan suggests it.
    expiry?.cancel()
    shown.cache = { ttl: account.isSubscription ? '1h' : '5m', isTtlKnown: false }
    shown.contextPercent = usage.context.percent
    shown.limits = usage.rateLimits
    $.ui.status(statusText(shown))
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain) {
      shown.model = e.model
      shown.effort = e.effort === undefined ? undefined : String(e.effort)
      $.ui.status(statusText(shown))
    }
    const response = yield* next(e)
    if (isMain && response.usage) {
      shown.cache = judgeCache(shown.cache, stepOf(response.usage, await $.clock.now()))
      $.ui.status(statusText(shown))
      // Left idle past the TTL, the next request writes the whole prefix again.
      expiry?.cancel()
      expiry = $.clock.after(TTL_MS[shown.cache.ttl], () => {
        shown.cache = { ...shown.cache, verdict: '⌛ expired' }
        $.ui.status(statusText(shown))
      })
    }
    return response
  })

  on('session.measure', ($, e, next) => {
    shown.contextPercent = e.context.percent
    shown.limits = e.rateLimits
    $.ui.status(statusText(shown))
    return next(e)
  })
}

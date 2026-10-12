import type { Register, SessionRateLimit } from 'claude-code'

type Shown = {
  account?: string
  model?: string
  effort?: string
  contextPercent?: number
  limits: SessionRateLimit[]
}

const LIMIT_LABELS: Record<string, string> = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' }

// The effort a session starts at: the model's own effortLevel in modelSettings, else the global one.
function effortFromSettings(settings: Readonly<Record<string, unknown>>, model: string): string | undefined {
  const byModel = settings.modelSettings as Record<string, { effortLevel?: unknown } | undefined> | undefined
  const level = byModel?.[model]?.effortLevel ?? settings.effortLevel
  return typeof level === 'string' || typeof level === 'number' ? String(level) : undefined
}

// The plan and organization the account signed in with, as ~/.claude.json's oauthAccount records them.
function accountFromConfig(text: string): string | undefined {
  const account = (JSON.parse(text) as { oauthAccount?: Record<string, unknown> }).oauthAccount
  if (!account) return undefined
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
  return parts.length ? parts.join(' · ') : undefined
}

function statusText(s: Shown): string | undefined {
  const parts = [
    s.account,
    s.model ? `${s.model}${s.effort ? ` (${s.effort})` : ''}` : undefined,
    s.contextPercent === undefined ? undefined : `ctx ${s.contextPercent}%`,
    s.limits.length ? s.limits.map(l => `${LIMIT_LABELS[l.kind] ?? l.kind} ${l.percentUsed}%`).join(' · ') : undefined,
  ].filter(Boolean)
  return parts.length ? parts.join(' │ ') : undefined
}

export const register: Register = on => {
  const shown: Shown = { limits: [] }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const usage = await $.session.usage()
    shown.model = await $.session.model()
    shown.effort ??= effortFromSettings(await $.settings.read(), shown.model)
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await $.env.get('HOME'))
    shown.account = await $.fs.read(`${configDir}/.claude.json`).then(accountFromConfig).catch(() => undefined)
    shown.contextPercent = usage.context.percent
    shown.limits = usage.rateLimits
    $.ui.status(statusText(shown))
    return started
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      shown.model = e.model
      shown.effort = e.effort === undefined ? undefined : String(e.effort)
      $.ui.status(statusText(shown))
    }
    return yield* next(e)
  })

  on('session.measure', ($, e, next) => {
    shown.contextPercent = e.context.percent
    shown.limits = e.rateLimits
    $.ui.status(statusText(shown))
    return next(e)
  })
}

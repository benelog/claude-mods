import type { Color, Register, SessionRateLimit, TurnUsage } from 'claude-code'

type Ttl = '5m' | '1h'

// One main-thread model request, as its response's usage reported it.
type Step = {
  at: number
  model: string
  read: number
  written: number
  prompt: number
}

// Where the TTL shown came from, weakest first: the plan alone, the GrowthBook flag, the account gone into overage, or a request.
type TtlSource = 'plan' | 'flag' | 'overage' | 'observed'

type Cache = {
  ttl: Ttl
  ttlSource: TtlSource
  last?: Step
  verdict?: string
}

// The working directory's name, with its branch inside a git repository.
type Location = { dir: string; branch?: string }

type Shown = {
  account?: string
  location?: Location
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

type ClaudeJson = {
  oauthAccount?: Record<string, unknown>
  cachedGrowthBookFeatures?: { tengu_prompt_cache_1h_config?: { allowlist?: unknown } }
}

// Whether the GrowthBook flag Claude Code last fetched gives an interactive session's main thread the one-hour TTL; undefined when the flag is not cached.
function isMainThreadOnOneHourTtl(config: ClaudeJson): boolean | undefined {
  const allowlist = config.cachedGrowthBookFeatures?.tengu_prompt_cache_1h_config?.allowlist
  if (!Array.isArray(allowlist)) return undefined
  return allowlist.some(pattern => typeof pattern === 'string' && globMatches(pattern, 'repl_main_thread'))
}

// A pattern whose `*` stands for any run of characters, as the allowlist writes them.
function globMatches(pattern: string, name: string): boolean {
  const [head = '', ...rest] = pattern.split('*')
  if (!rest.length) return pattern === name
  if (!name.startsWith(head)) return false
  let from = head.length
  for (const [i, part] of rest.entries()) {
    const isLast = i === rest.length - 1
    const at = isLast ? name.length - part.length : name.indexOf(part, from)
    if (at < from) return false
    from = at + part.length
  }
  return true
}

// The TTL a session starts with: what the flag says on a subscription, else what the plan suggests.
function initialCache(config: ClaudeJson, isSubscription: boolean): Cache {
  const isOneHour = isMainThreadOnOneHourTtl(config)
  if (isSubscription && isOneHour !== undefined) return { ttl: isOneHour ? '1h' : '5m', ttlSource: 'flag' }
  return { ttl: isSubscription ? '1h' : '5m', ttlSource: 'plan' }
}

// The plan and organization the account signed in with, as ~/.claude.json's oauthAccount records them.
function accountFromConfig(config: ClaudeJson): { label?: string; isSubscription: boolean } {
  const account = config.oauthAccount
  if (!account) return { isSubscription: false }
  const type = typeof account.organizationType === 'string' ? account.organizationType : undefined
  const tier = typeof account.organizationRateLimitTier === 'string' ? account.organizationRateLimitTier : ''
  const multiplier = /_(\d+x)$/.exec(tier)?.[1]
  const plan = type?.replace(/^claude_/, '').replace(/^./, c => c.toUpperCase())
  const name = typeof account.organizationName === 'string' ? account.organizationName : undefined
  // A personal plan's organization is the one created with the account, named after its email.
  const org = name?.endsWith("'s Organization") ? 'personal' : name
  const parts = [
    plan ? `${plan}${multiplier ? ` ${multiplier}` : ''}` : undefined,
    org,
  ].filter(Boolean)
  return {
    label: parts.length ? parts.join(' · ') : undefined,
    isSubscription: /^claude_(pro|max|team|enterprise)$/.test(type ?? ''),
  }
}

// The current branch, or the short commit when HEAD is detached, found by walking up from cwd to the nearest .git; undefined outside a repository.
async function branchOf(cwd: string, read: (path: string) => Promise<string>): Promise<string | undefined> {
  for (let dir = cwd; ; dir = dir.slice(0, dir.lastIndexOf('/')) || '/') {
    let gitDir = `${dir === '/' ? '' : dir}/.git`
    let head = await read(`${gitDir}/HEAD`).catch(() => undefined)
    if (head === undefined) {
      // A worktree or submodule keeps a .git file that points at the real directory.
      const pointer = /^gitdir: (.+)$/m.exec(await read(gitDir).catch(() => ''))?.[1]
      if (pointer) {
        gitDir = pointer.startsWith('/') ? pointer : `${dir}/${pointer}`
        head = await read(`${gitDir}/HEAD`).catch(() => undefined)
      }
    }
    if (head !== undefined) {
      const ref = /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]
      return ref ?? head.trim().slice(0, 7)
    }
    if (dir === '/') return undefined
  }
}

async function locationOf($: { fs: { read: (path: string) => Promise<string> } }, cwd: string): Promise<Location> {
  const branch = await branchOf(cwd, path => $.fs.read(path))
  return { dir: cwd.slice(cwd.lastIndexOf('/') + 1) || '/', branch }
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
    const learned = gap > TTL_MS['5m'] ? { ttl: '1h' as const, ttlSource: 'observed' as const } : {}
    return { ...cache, ...learned, last: step, verdict: `✓ ${hitPercent}%` }
  }
  if (step.model !== prev.model) return { ...cache, last: step, verdict: '✗ model changed' }
  if (step.prompt < 0.5 * prev.prompt) return { ...cache, last: step, verdict: '✗ compacted' }
  if (gap > TTL_MS[cache.ttl]) return { ...cache, last: step, verdict: '✗ expired' }
  // A miss inside the hour after more than five minutes idle points to a five-minute TTL.
  if (gap > TTL_MS['5m']) return { ...cache, ttl: '5m', ttlSource: 'observed', last: step, verdict: '✗ expired' }
  return { ...cache, last: step, verdict: '✗ broken' }
}

// A subscription past a rate-limit window runs on extra usage, where requests drop to the five-minute TTL; back under it, the session's own TTL returns.
function withOverage(cache: Cache, limits: SessionRateLimit[], isSubscription: boolean, initial: Cache): Cache {
  if (cache.ttlSource === 'observed') return cache
  if (isSubscription && limits.some(l => l.percentUsed >= 100)) return { ...cache, ttl: '5m', ttlSource: 'overage' }
  return cache.ttlSource === 'overage' ? { ...cache, ttl: initial.ttl, ttlSource: initial.ttlSource } : cache
}

// A run of text in one color; the colors are theme keys, so the line follows the person's theme.
type Piece = [text: string, color: Color]

const DIM = 'inactive'
const DOT: Piece = [' · ', DIM]
const BAR: Piece = [' │ ', DIM]

// How full a context or quota window is: plenty left, getting close, at the limit.
const usageColor = (percent: number): Color => (percent >= 80 ? 'error' : percent >= 50 ? 'warning' : 'success')

const VERDICT_COLORS: Record<string, Color> = { '✓': 'success', '✗': 'error', '⌛': 'warning' }

const TTL_MARKS: Record<TtlSource, Piece[]> = { plan: [['?', DIM]], flag: [], overage: [[' (overage)', 'warning']], observed: [] }

function entries(s: Shown): Piece[][] {
  const { cache, location } = s
  const all: Piece[][] = [
    s.account ? [[s.account, 'merged']] : [],
    location ? [[location.dir, 'ide'], ...(location.branch ? ([[' (', DIM], [location.branch, 'bashBorder'], [')', DIM]] as Piece[]) : [])] : [],
    s.model ? [[s.model, 'claude'], ...(s.effort ? ([[` (${s.effort})`, DIM]] as Piece[]) : [])] : [],
    s.contextPercent === undefined ? [] : [['ctx ', DIM], [`${s.contextPercent}%`, usageColor(s.contextPercent)]],
    [
      ['cache ', DIM],
      ...(cache.verdict ? ([[cache.verdict, VERDICT_COLORS[cache.verdict.slice(0, 1)] ?? DIM], DOT] as Piece[]) : []),
      ['ttl ', DIM],
      [cache.ttl, 'text'],
      ...TTL_MARKS[cache.ttlSource],
    ],
    s.limits.flatMap((l, i): Piece[] => [
      ...(i ? [DOT] : []),
      [`${LIMIT_LABELS[l.kind] ?? l.kind} `, DIM],
      [`${l.percentUsed}%`, usageColor(l.percentUsed)],
    ]),
  ]
  return all.filter(entry => entry.length)
}

// The entries one after another, a bar between each two.
const hudLine = (s: Shown): Piece[] => entries(s).flatMap((entry, i) => (i ? [BAR, ...entry] : entry))

export const register: Register = on => {
  const shown: Shown = { limits: [], cache: { ttl: '5m', ttlSource: 'plan' } }
  let expiry: { cancel: () => void } | undefined
  let isSubscription = false
  let initial: Cache = shown.cache
  let cwd: string | undefined

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const usage = await $.session.usage()
    shown.model = await $.session.model()
    shown.effort ??= effortFromSettings(await $.settings.read(), shown.model)
    const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? (await $.env.get('HOME'))
    const config = await $.fs
      .read(`${configDir}/.claude.json`)
      .then(text => JSON.parse(text) as ClaudeJson)
      .catch((): ClaudeJson => ({}))
    const account = accountFromConfig(config)
    shown.account = account.label
    cwd = e.cwd
    shown.location = await locationOf($, cwd)
    isSubscription = account.isSubscription
    // A new conversation starts a new prefix; until a request shows the TTL, the flag or the plan says it.
    expiry?.cancel()
    shown.contextPercent = usage.context.percent
    shown.limits = usage.rateLimits
    initial = initialCache(config, isSubscription)
    shown.cache = withOverage(initial, shown.limits, isSubscription, initial)
    $.ui.invalidate('ui.render')
    return started
  })

  on('turn.step', async function* ($, e, next) {
    const isMain = e.agentId === undefined
    if (isMain) {
      // The branch can change mid-session, so it is read again before each model request and each measurement.
      if (cwd !== undefined) shown.location = await locationOf($, cwd)
      shown.model = e.model
      shown.effort = e.effort === undefined ? undefined : String(e.effort)
      $.ui.invalidate('ui.render')
    }
    const response = yield* next(e)
    if (isMain && response.usage) {
      shown.cache = judgeCache(shown.cache, stepOf(response.usage, await $.clock.now()))
      $.ui.invalidate('ui.render')
      // Left idle past the TTL, the next request writes the whole prefix again.
      expiry?.cancel()
      expiry = $.clock.after(TTL_MS[shown.cache.ttl], () => {
        shown.cache = { ...shown.cache, verdict: '⌛ expired' }
        $.ui.invalidate('ui.render')
      })
    }
    return response
  })

  // The band above the prompt draws the line; a survey there takes its place until answered.
  on('ui.render', { component: 'AbovePrompt' }, ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="hud">
        <Text wrap="truncate-end">
          {hudLine(shown).map(([text, color]) => (
            <Text color={color}>{text}</Text>
          ))}
        </Text>
      </Box>
    )
  })

  on('session.measure', async ($, e, next) => {
    if (cwd !== undefined) shown.location = await locationOf($, cwd)
    shown.contextPercent = e.context.percent
    shown.limits = e.rateLimits
    shown.cache = withOverage(shown.cache, shown.limits, isSubscription, initial)
    $.ui.invalidate('ui.render')
    return next(e)
  })
}

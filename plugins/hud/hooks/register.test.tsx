import { test, expect, mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, TurnUsage } from 'claude-code'

const MINUTE = 60_000

const BAND = {
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

// The line the band above the prompt draws, as read.
async function drawn($: Engine): Promise<string | undefined> {
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND })
  const line = await ui.find({ key: 'hud' })
  await ui.unmount()
  return line?.text
}

// The same line as runs of text, each with its color.
async function drawnRuns($: Engine): Promise<[string, unknown][]> {
  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND })
  const texts = await ui.findAll({ type: 'Text' })
  await ui.unmount()
  return texts.filter(t => t.props.color !== undefined).map(t => [t.text, t.props.color])
}

// Answers each main-thread model request with the next usage in the queue.
function answerSteps(on: On, usages: TurnUsage[]): void {
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: usages.shift() ?? null } as never
  })
}

function usage(read: number, written: number, model = 'claude-opus-5-5'): TurnUsage {
  return { model, input_tokens: 100, output_tokens: 10, cache_read_input_tokens: read, cache_creation_input_tokens: written }
}

async function step($: Engine): Promise<void> {
  const stream = $.turn.step({ turnId: 't', index: 0, model: 'claude-opus-5-5', effort: 'high', messageCount: 1 } as never)
  for await (const _ of stream);
}

test('shows context and rate-limit usage above the prompt', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { window: 200000, tokens: 84000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23.5 },
      { kind: 'seven_day', percentUsed: 7 },
    ],
    changed: ['context', 'rateLimits'],
  })

  expect(await drawn($)).toBe('ctx 42% │ cache ttl 5m? │ 5h 23.5% · 7d 7%')
})

test('colors each entry, and usage by how close it is to the limit', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { window: 200000, tokens: 84000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 85 },
      { kind: 'seven_day', percentUsed: 60 },
    ],
    changed: ['context', 'rateLimits'],
  })

  expect(await drawnRuns($)).toEqual([
    ['ctx ', 'inactive'],
    ['42%', 'success'],
    [' │ ', 'inactive'],
    ['cache ', 'inactive'],
    ['ttl ', 'inactive'],
    ['5m', 'text'],
    ['?', 'inactive'],
    [' │ ', 'inactive'],
    ['5h ', 'inactive'],
    ['85%', 'error'],
    [' · ', 'inactive'],
    ['7d ', 'inactive'],
    ['60%', 'warning'],
  ])
})

test('gives the band to a survey', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box key="survey">
        <Text>How is Claude doing this session?</Text>
      </Box>
    )
  })

  const ui = await $.ui.mount({ plugin: 'hud', surface: 'terminal', ...BAND, props: { ...BAND.props, hasSurvey: true } })
  expect(await ui.find({ key: 'survey' })).toBeDefined()
  expect(await ui.find({ key: 'hud' })).toBeUndefined()
  await ui.unmount()
})

// Starts a session on a Max plan, with the GrowthBook flag cached as given (left out when undefined).
async function startSession(
  $: Engine,
  on: On,
  allowlist?: string[],
): Promise<void> {
  on('session.start', () => ({ cwd: '/work/proj' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }) as never)
  on('settings.read', () => ({
    value: { effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } },
  }) as never)
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/someone' : undefined }) as never)
  on('fs.read', (_, e) => {
    if (e.path === '/work/proj/.git/HEAD') return { value: 'ref: refs/heads/main\n' } as never
    expect(e.path).toBe('/home/someone/.claude.json')
    return {
      value: JSON.stringify({
        oauthAccount: {
          organizationType: 'claude_max',
          organizationRateLimitTier: 'default_claude_max_20x',
          organizationName: "someone@example.com's Organization",
          organizationRole: 'admin',
        },
        ...(allowlist && { cachedGrowthBookFeatures: { tengu_prompt_cache_1h_config: { allowlist } } }),
      }),
    } as never
  })
  await $.session.start({ source: 'startup', cwd: '/work/proj' } as never)
}

test('shows the plan, the model and its effort from settings when the session starts', async ($, on) => {
  await startSession($, on)

  expect(await drawn($)).toBe('Max 20x · personal │ proj (main) │ claude-opus-5-5 (high) │ cache ttl 1h?')
})

test('takes the TTL from the GrowthBook flag when it is cached', async ($, on) => {
  await startSession($, on, ['repl_main_thread*', 'sdk'])

  expect(await drawn($)).toBe('Max 20x · personal │ proj (main) │ claude-opus-5-5 (high) │ cache ttl 1h')
})

test('takes a five-minute TTL when the flag leaves the main thread out', async ($, on) => {
  await startSession($, on, ['sdk'])

  expect(await drawn($)).toBe('Max 20x · personal │ proj (main) │ claude-opus-5-5 (high) │ cache ttl 5m')
})

test('drops to a five-minute TTL in overage and returns when the window resets', async ($, on) => {
  on('session.measure', (_, e) => ({ changed: e.changed }))
  await startSession($, on, ['repl_main_thread*'])

  await $.session.measure({ context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 100 }], changed: ['rateLimits'] })
  expect(await drawn($)).toBe('Max 20x · personal │ proj (main) │ claude-opus-5-5 (high) │ cache ttl 5m (overage) │ 5h 100%')

  await $.session.measure({ context: { window: 200000 }, rateLimits: [{ kind: 'five_hour', percentUsed: 0 }], changed: ['rateLimits'] })
  expect(await drawn($)).toBe('Max 20x · personal │ proj (main) │ claude-opus-5-5 (high) │ cache ttl 1h │ 5h 0%')
})

test('learns a one-hour TTL from a hit after ten idle minutes, and marks the prefix expired an hour later', async ($, on) => {
  const clock = mock.clock(on)
  answerSteps(on, [usage(0, 50000), usage(50000, 2000), usage(0, 52000)])

  await step($)
  expect(await drawn($)).toBe('claude-opus-5-5 (high) │ cache new · ttl 5m?')

  await clock.advance(10 * MINUTE)
  await step($)
  expect(await drawn($)).toBe('claude-opus-5-5 (high) │ cache ✓ 96% · ttl 1h')

  await clock.advance(61 * MINUTE)
  expect(await drawn($)).toBe('claude-opus-5-5 (high) │ cache ⌛ expired · ttl 1h')

  await step($)
  expect(await drawn($)).toBe('claude-opus-5-5 (high) │ cache ✗ expired · ttl 1h')
})

test('calls a miss within the TTL broken, and one after a model change by its cause', async ($, on) => {
  const clock = mock.clock(on)
  answerSteps(on, [usage(0, 50000), usage(0, 50100), usage(0, 50200, 'claude-sonnet-5-5')])

  await step($)
  await clock.advance(MINUTE)
  await step($)
  expect(await drawn($)).toBe('claude-opus-5-5 (high) │ cache ✗ broken · ttl 5m?')

  await step($)
  expect(await drawn($)).toBe('claude-opus-5-5 (high) │ cache ✗ model changed · ttl 5m?')
})

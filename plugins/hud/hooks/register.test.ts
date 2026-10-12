import { test, expect } from 'claude-code/testing'

test('shows context and rate-limit usage on the status line', async ($, on) => {
  const shown: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    shown.push(e.text)
    return { value: undefined } as never
  })
  on('session.measure', (_, e) => ({ changed: e.changed }))

  await $.session.measure({
    context: { window: 200000, tokens: 84000, percent: 42 },
    rateLimits: [
      { kind: 'five_hour', percentUsed: 23.5 },
      { kind: 'seven_day', percentUsed: 7 },
    ],
    changed: ['context', 'rateLimits'],
  })

  expect(shown.at(-1)).toBe('ctx 42% │ 5h 23.5% · 7d 7%')
})

test('shows the model and its effort from settings when the session starts', async ($, on) => {
  const shown: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    shown.push(e.text)
    return { value: undefined } as never
  })
  on('session.start', () => ({ cwd: '/' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }) as never)
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200000 }, rateLimits: [] } }) as never)
  on('settings.read', () => ({
    value: { effortLevel: 'medium', modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } } },
  }) as never)

  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/home/someone' : undefined }) as never)
  on('fs.read', (_, e) => {
    expect(e.path).toBe('/home/someone/.claude.json')
    return {
      value: JSON.stringify({
        oauthAccount: {
          organizationType: 'claude_max',
          organizationRateLimitTier: 'default_claude_max_20x',
          organizationName: "someone@example.com's Organization",
          organizationRole: 'admin',
        },
      }),
    } as never
  })

  await $.session.start({ source: 'startup', cwd: '/' } as never)

  expect(shown.at(-1)).toBe('Max 20x · personal (admin) │ claude-opus-5-5 (high)')
})

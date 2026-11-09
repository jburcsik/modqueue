import { describe, expect, it } from 'vitest'
import { runAutomatedAction } from '../src/automation.js'
import type { ModerationDecision, Settings } from '../src/types.js'
import { USER_A, makeDeps, settingsWith } from './helpers.js'

function decision(overrides: Partial<ModerationDecision>): ModerationDecision {
  return { tier: 'allow', severity: null, flaggedCategories: [], scores: {}, confidence: 0, reason: null, providerUnavailable: false, ...overrides }
}

const hold = (confidence: number) => decision({ tier: 'hold', severity: 'violation', confidence, flaggedCategories: ['harassment'], reason: 'Content held: high risk score' })
const warn = (confidence: number) => decision({ tier: 'warn', severity: 'warning', confidence, reason: 'Content contains potentially sensitive language' })
const severe = decision({ tier: 'hold', severity: 'severe', confidence: 0.99 })
const allow = decision({ tier: 'allow' })
const allowLog = decision({ tier: 'allow_log', severity: 'info', confidence: 0.3 })

async function run(settings: Partial<Settings>, verdict: ModerationDecision) {
  const deps = makeDeps()
  const content = deps.store.addContent({ ownerId: USER_A, body: 'a post' })
  const result = await runAutomatedAction(
    deps.store,
    deps.notifier,
    { contentId: content.id, ownerId: USER_A, decision: verdict, settings: settingsWith(settings), providerName: 'fixture' },
    deps.config,
    deps.clock,
  )
  const events = await deps.store.listEvents('content', content.id, 10)
  return { deps, content, result, events, state: deps.store.getContent(content.id)?.moderationState }
}

const acknowledged = { automationLevel: 'full_auto', fullAutoAcknowledgedAt: '2030-01-01T00:00:00.000Z' } as const

describe('automation off', () => {
  it('writes nothing', async () => {
    const { result, events, state } = await run({ automationLevel: 'off' }, hold(0.99))
    expect(result).toEqual({ acted: false, op: null, logged: null, eventId: null })
    expect(events).toHaveLength(0)
    expect(state).toBe('visible')
  })
})

describe('automation assist', () => {
  it('shadow logs what it would have done and touches nothing', async () => {
    const { result, events, state } = await run({ automationLevel: 'assist' }, hold(0.99))
    expect(result).toMatchObject({ acted: false, op: null, logged: 'ai_flag' })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ eventType: 'ai_flag', source: 'automated', severity: 'violation' })
    expect(events[0]?.details).toMatchObject({ action: 'shadow_only', would_have: 'remove_or_hold', provider: 'fixture', tier: 'hold', confidence: 0.99 })
    expect(state).toBe('visible')
  })
})

describe('automation semi_auto', () => {
  it('holds at or above the confidence floor and opens a case', async () => {
    const { deps, content, result, events, state } = await run({ automationLevel: 'semi_auto' }, hold(0.75))
    expect(result).toMatchObject({ acted: true, op: 'hold', logged: null })
    expect(state).toBe('held')
    expect(events[0]).toMatchObject({ eventType: 'content_hold', source: 'automated', priorState: 'visible' })
    expect(await deps.store.openCaseFor(content.id)).not.toBeNull()
    expect(events[0]?.caseId).toBe((await deps.store.openCaseFor(content.id))?.id)
  })

  it('shadow logs a hold below the confidence floor', async () => {
    const { result, events, state } = await run({ automationLevel: 'semi_auto' }, hold(0.74))
    expect(result.logged).toBe('ai_flag')
    expect(events[0]?.details).toMatchObject({ action: 'shadow_only' })
    expect(state).toBe('visible')
  })

  it('logs an auto allow for allow tiers and shadow logs a warn', async () => {
    expect((await run({ automationLevel: 'semi_auto' }, allow)).result.logged).toBe('auto_allow')
    expect((await run({ automationLevel: 'semi_auto' }, allowLog)).result.logged).toBe('auto_allow')
    expect((await run({ automationLevel: 'semi_auto' }, warn(0.99))).result.logged).toBe('ai_flag')
  })

  it('never adds a strike', async () => {
    const { deps } = await run({ automationLevel: 'semi_auto' }, hold(0.99))
    expect(await deps.store.activeStrikePoints(USER_A)).toBe(0)
  })
})

describe('automation full_auto', () => {
  it('escalates severe content to humans without acting', async () => {
    const { result, events, state } = await run(acknowledged, severe)
    expect(result).toMatchObject({ acted: false, logged: 'escalated' })
    expect(events[0]).toMatchObject({ eventType: 'escalated', severity: 'severe' })
    expect(events[0]?.details).toMatchObject({ reason: 'severe_content' })
    expect(state).toBe('visible')
  })

  it('removes with a violation strike at or above the remove floor', async () => {
    const { deps, content, result, state } = await run(acknowledged, hold(0.95))
    expect(result).toMatchObject({ acted: true, op: 'remove' })
    expect(state).toBe('removed')
    expect(await deps.store.activeStrikePoints(USER_A)).toBe(deps.config.strikes.weights.violation.points)
    const caseRow = (await deps.store.readQueue({ filter: 'decided', callerId: USER_A, ownerId: null, includeIdentity: true, limit: 10 }))[0]
    expect(caseRow).toMatchObject({ contentId: content.id, caseState: 'decided' })
    expect(caseRow?.events[0]).toMatchObject({ eventType: 'content_remove', source: 'automated' })
  })

  it('holds below the remove floor', async () => {
    const { result, state } = await run(acknowledged, hold(0.94))
    expect(result).toMatchObject({ acted: true, op: 'hold' })
    expect(state).toBe('held')
  })

  it('uses the higher of the confidence floor and the remove floor', async () => {
    const { result } = await run({ ...acknowledged, autoActionConfidence: 0.98 }, hold(0.96))
    expect(result.op).toBe('hold')
  })

  it('warns with a warning strike at confidence and shadow logs below it', async () => {
    const warned = await run(acknowledged, warn(0.75))
    expect(warned.result).toMatchObject({ acted: true, op: 'warn' })
    expect(warned.state).toBe('visible')
    expect(warned.events[0]).toMatchObject({ eventType: 'content_warn', source: 'automated' })
    expect(await warned.deps.store.activeStrikePoints(USER_A)).toBe(warned.deps.config.strikes.weights.warning.points)
    expect((await run(acknowledged, warn(0.74))).result.logged).toBe('ai_flag')
  })

  it('logs an auto allow for allow tiers', async () => {
    expect((await run(acknowledged, allow)).result.logged).toBe('auto_allow')
  })

  it('without an acknowledgement writes an escalation and runs as semi_auto', async () => {
    const { result, events, state, deps } = await run({ automationLevel: 'full_auto', fullAutoAcknowledgedAt: null }, hold(0.99))
    expect(result).toMatchObject({ acted: true, op: 'hold' })
    expect(state).toBe('held')
    expect(events.map((e) => e.eventType)).toEqual(['content_hold', 'escalated'])
    expect(events[1]?.details).toMatchObject({ reason: 'full_auto_not_acknowledged' })
    expect(await deps.store.activeStrikePoints(USER_A)).toBe(0)
  })
})

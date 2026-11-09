import { describe, expect, it } from 'vitest'
import { addStrike, applyModerationAction, buildActionSummary, logUserLookup, revokeStrike } from '../src/actions.js'
import { ModerationError, type ModerationActionInput } from '../src/types.js'
import { ADMIN_A, REVIEWER_A, USER_A, USER_B, makeDeps, type TestDeps } from './helpers.js'

function action(overrides: Partial<ModerationActionInput> & Pick<ModerationActionInput, 'targetId' | 'op'>): ModerationActionInput {
  return {
    targetType: 'content',
    actor: 'moderator',
    actorId: REVIEWER_A,
    actorName: 'Reviewer A',
    reason: null,
    confidence: null,
    strike: null,
    ownerId: USER_A,
    issueType: null,
    caseId: null,
    ...overrides,
  }
}

async function heldWithReport(deps: TestDeps) {
  const content = deps.store.addContent({ ownerId: USER_A, body: 'reported post' })
  const reportId = await deps.store.fileReport({ reporterId: USER_B, targetId: content.id, reason: 'spam', evidencePaths: [] })
  await deps.store.setContentState(content.id, 'held')
  const caseRow = await deps.store.openCaseFor(content.id)
  return { content, reportId, caseId: caseRow?.id as string }
}

describe('buildActionSummary', () => {
  const config = makeDeps().config

  it('names the actor, the op and the strike with its points', () => {
    const text = buildActionSummary(action({ targetId: 'x', op: 'remove', strike: { severity: 'violation', reason: 'repeat spam' } }), config)
    expect(text).toBe('Reviewer A removed this content and added a Violation strike (3 points): "repeat spam"')
  })

  it('falls back to a role label and the configured automated label', () => {
    expect(buildActionSummary(action({ targetId: 'x', op: 'approve', actorName: null, actor: 'admin', actorId: ADMIN_A }), config)).toBe('An admin approved this content')
    expect(buildActionSummary(action({ targetId: 'x', op: 'hold', actor: 'automated', actorId: null, actorName: null }), config)).toBe(
      `${config.automation.automatedActorLabel} held this content`,
    )
  })

  it('quotes the note text for a note', () => {
    expect(buildActionSummary(action({ targetId: 'x', op: 'note', reason: ' watch this one ' }), config)).toBe('Reviewer A left a note on this content: "watch this one"')
  })
})

describe('applyModerationAction ops', () => {
  it('approve settles the case as keep, upholds reports and notifies the host with a reach policy', async () => {
    const deps = makeDeps()
    const { content, caseId, reportId } = await heldWithReport(deps)
    const result = await applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'approve', caseId }), deps.config, deps.clock)
    expect(deps.store.getContent(content.id)?.moderationState).toBe('visible')
    expect(result.decision).toMatchObject({ caseId, decision: 'keep', priorState: 'held', moderationState: 'visible', reportsResolved: 1 })
    expect((await deps.store.getCase(caseId))?.state).toBe('decided')
    expect((await deps.store.listReports(content.id)).find((r) => r.id === reportId)?.state).toBe('upheld')
    const event = await deps.store.getEvent(result.eventId as string)
    expect(event).toMatchObject({ eventType: 'content_approve', caseId, source: 'moderator', actorId: REVIEWER_A, priorState: 'held' })
    expect(deps.notifier.onContentApproved).toHaveBeenCalledTimes(1)
    expect(deps.notifier.onContentApproved.mock.calls[0]?.[0]).toMatchObject({ contentId: content.id, ownerId: USER_A })
  })

  it('dismiss settles the case as keep and rejects reports', async () => {
    const deps = makeDeps()
    const { content, caseId, reportId } = await heldWithReport(deps)
    const result = await applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'dismiss', caseId }), deps.config, deps.clock)
    expect(result.decision?.decision).toBe('keep')
    expect((await deps.store.listReports(content.id)).find((r) => r.id === reportId)?.state).toBe('rejected')
    expect(deps.store.getContent(content.id)?.moderationState).toBe('visible')
    expect(deps.notifier.onContentApproved).not.toHaveBeenCalled()
  })

  it('remove settles the case as remove and upholds reports', async () => {
    const deps = makeDeps()
    const { content, caseId, reportId } = await heldWithReport(deps)
    const result = await applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'remove', reason: 'spam', caseId }), deps.config, deps.clock)
    expect(deps.store.getContent(content.id)?.moderationState).toBe('removed')
    expect(result.decision?.decision).toBe('remove')
    expect((await deps.store.listReports(content.id)).find((r) => r.id === reportId)?.state).toBe('upheld')
    expect(await deps.store.getEvent(result.eventId as string)).toMatchObject({ eventType: 'content_remove', severity: 'violation', caseId })
  })

  it('opens a case when settling content that has none', async () => {
    const deps = makeDeps()
    const content = deps.store.addContent({ ownerId: USER_A })
    const result = await applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'remove', reason: 'spam' }), deps.config, deps.clock)
    expect(result.decision?.caseId).toBeTruthy()
    expect((await deps.store.getCase(result.decision?.caseId as string))?.state).toBe('decided')
  })

  it('hold sets the state, opens a case and writes content_hold with the case id', async () => {
    const deps = makeDeps()
    const content = deps.store.addContent({ ownerId: USER_A })
    const result = await applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'hold', reason: 'needs a look' }), deps.config, deps.clock)
    expect(deps.store.getContent(content.id)?.moderationState).toBe('held')
    const caseRow = await deps.store.openCaseFor(content.id)
    expect(caseRow?.state).toBe('open')
    expect(await deps.store.getEvent(result.eventId as string)).toMatchObject({
      eventType: 'content_hold',
      severity: 'warning',
      caseId: caseRow?.id,
      priorState: 'visible',
      details: { action: 'hold', actor: 'moderator', reason: 'needs a look' },
    })
    expect(result.decision).toBeNull()
  })

  it('hold throws not_found for missing content', async () => {
    const deps = makeDeps()
    await expect(applyModerationAction(deps.store, deps.notifier, action({ targetId: 'missing', op: 'hold' }), deps.config, deps.clock)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('warn leaves the state alone and writes content_warn', async () => {
    const deps = makeDeps()
    const content = deps.store.addContent({ ownerId: USER_A })
    const result = await applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'warn', issueType: 'tone' }), deps.config, deps.clock)
    expect(deps.store.getContent(content.id)?.moderationState).toBe('visible')
    expect(await deps.store.getEvent(result.eventId as string)).toMatchObject({ eventType: 'content_warn', severity: 'warning', details: { issue_type: 'tone' } })
    expect(await deps.store.openCaseFor(content.id)).toBeNull()
  })

  it('note writes mod_note only', async () => {
    const deps = makeDeps()
    const content = deps.store.addContent({ ownerId: USER_A })
    const result = await applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'note', reason: 'seen' }), deps.config, deps.clock)
    expect(await deps.store.getEvent(result.eventId as string)).toMatchObject({ eventType: 'mod_note', severity: 'info', summary: 'Reviewer A left a note on this content: "seen"' })
    expect((await deps.store.listEvents('content', content.id, 10))).toHaveLength(1)
  })

  it('carries the caller supplied case id onto the event', async () => {
    const deps = makeDeps()
    const content = deps.store.addContent({ ownerId: USER_A })
    const caseRow = await deps.store.openCase(content.id)
    const result = await applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'note', reason: 'seen', caseId: caseRow.id }), deps.config, deps.clock)
    expect((await deps.store.getEvent(result.eventId as string))?.caseId).toBe(caseRow.id)
  })

  it('refuses a case id that belongs to another target or does not exist', async () => {
    const deps = makeDeps()
    const { caseId } = await heldWithReport(deps)
    const other = deps.store.addContent({ ownerId: USER_A, body: 'another post' })
    await expect(applyModerationAction(deps.store, deps.notifier, action({ targetId: other.id, op: 'remove', reason: 'spam', caseId }), deps.config, deps.clock)).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(applyModerationAction(deps.store, deps.notifier, action({ targetId: other.id, op: 'note', reason: 'seen', caseId: 'missing' }), deps.config, deps.clock)).rejects.toMatchObject({ code: 'invalid_input' })
    expect(deps.store.getContent(other.id)?.moderationState).toBe('visible')
    expect(await deps.store.listEvents('content', other.id, 10)).toHaveLength(0)
  })

  it('allows warn and note on a user target and refuses content ops', async () => {
    const deps = makeDeps()
    const result = await applyModerationAction(
      deps.store,
      deps.notifier,
      action({ targetType: 'user', targetId: USER_A, op: 'warn', ownerId: null, strike: { severity: 'warning', reason: 'tone' } }),
      deps.config,
      deps.clock,
    )
    expect(result.strikeId).toBeTruthy()
    expect(await deps.store.activeStrikePoints(USER_A)).toBe(2)
    await expect(
      applyModerationAction(deps.store, deps.notifier, action({ targetType: 'user', targetId: USER_A, op: 'approve', ownerId: null }), deps.config, deps.clock),
    ).rejects.toSatisfy((error) => ModerationError.is(error) && error.code === 'invalid_input')
  })

  it('refuses a strike with no owner', async () => {
    const deps = makeDeps()
    const content = deps.store.addContent({ ownerId: USER_A })
    await expect(
      applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'warn', ownerId: null, strike: { severity: 'info', reason: 'x' } }), deps.config, deps.clock),
    ).rejects.toMatchObject({ code: 'invalid_input' })
  })
})

describe('strikes and notifications', () => {
  it('weights the strike by severity, links it to the event and logs strike_added', async () => {
    const deps = makeDeps()
    const content = deps.store.addContent({ ownerId: USER_A })
    const result = await applyModerationAction(
      deps.store,
      deps.notifier,
      action({ targetId: content.id, op: 'warn', strike: { severity: 'violation', reason: 'repeat' } }),
      deps.config,
      deps.clock,
    )
    const strike = await deps.store.getStrike(result.strikeId as string)
    expect(strike).toMatchObject({ userId: USER_A, severity: 'violation', points: 3, reason: 'repeat', moderationEventId: result.eventId })
    expect(strike?.expiresAt).toBe(new Date(deps.clock.now() + 60 * 24 * 60 * 60 * 1000).toISOString())
    const userEvents = await deps.store.listEvents('user', USER_A, 10)
    expect(userEvents[0]).toMatchObject({ eventType: 'strike_added', severity: 'violation', details: { strike_id: result.strikeId, points: 3 } })
    expect(result.consequenceBefore?.tier).toBe('clean')
    expect(result.consequenceAfter?.tier).toBe('nudge')
  })

  it('notifies once per upward tier change and stays silent inside a tier', async () => {
    const deps = makeDeps()
    const content = deps.store.addContent({ ownerId: USER_A })
    const strike = (severity: 'info' | 'warning' | 'violation', issueType: 'tone' | null = null) =>
      applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'warn', issueType, strike: { severity, reason: 'r' } }), deps.config, deps.clock)

    await strike('warning')
    expect(deps.notifier.onTierEscalated).not.toHaveBeenCalled()
    const second = await strike('warning', 'tone')
    expect(deps.notifier.onTierEscalated).toHaveBeenCalledTimes(1)
    expect(deps.notifier.onTierEscalated.mock.calls[0]?.[0]).toMatchObject({ userId: USER_A, tier: 'warned', messageKey: 'warning', issueType: 'tone', strikeId: second.strikeId, eventId: second.eventId })
    await strike('info')
    expect(deps.notifier.onTierEscalated).toHaveBeenCalledTimes(1)
    await strike('violation')
    expect(deps.notifier.onTierEscalated).toHaveBeenCalledTimes(2)
    expect(deps.notifier.onTierEscalated.mock.calls[1]?.[0]).toMatchObject({ tier: 'quieted', messageKey: 'quieted' })
  })

  it('is silent on the way down and when a strike lands in a lower tier than before', async () => {
    const deps = makeDeps()
    const first = await addStrike(deps.store, deps.notifier, { userId: USER_A, severity: 'warning', reason: 'a', source: 'moderator', actorId: REVIEWER_A, moderationEventId: null, caseId: null }, deps.config, deps.clock)
    const second = await addStrike(deps.store, deps.notifier, { userId: USER_A, severity: 'warning', reason: 'b', source: 'moderator', actorId: REVIEWER_A, moderationEventId: null, caseId: null }, deps.config, deps.clock)
    expect(deps.notifier.onTierEscalated).toHaveBeenCalledTimes(1)

    await revokeStrike(deps.store, first.strikeId as string, ADMIN_A, 'admin', 'appeal')
    await revokeStrike(deps.store, second.strikeId as string, ADMIN_A, 'admin', 'appeal')
    expect(await deps.store.activeStrikePoints(USER_A)).toBe(0)
    expect(deps.notifier.onTierEscalated).toHaveBeenCalledTimes(1)
    expect((await deps.store.listEvents('user', USER_A, 10)).filter((e) => e.eventType === 'strike_revoked')).toHaveLength(2)

    const nudge = await addStrike(deps.store, deps.notifier, { userId: USER_A, severity: 'info', reason: 'c', source: 'moderator', actorId: REVIEWER_A, moderationEventId: null, caseId: null }, deps.config, deps.clock)
    expect(nudge.consequenceAfter.tier).toBe('clean')
    expect(nudge.notified).toBe(false)
    expect(deps.notifier.onTierEscalated).toHaveBeenCalledTimes(1)
  })

  it('expired strikes stop counting', async () => {
    const deps = makeDeps()
    await addStrike(deps.store, deps.notifier, { userId: USER_A, severity: 'violation', reason: 'a', source: 'system', actorId: null, moderationEventId: null, caseId: null }, deps.config, deps.clock)
    expect(await deps.store.activeStrikePoints(USER_A)).toBe(3)
    deps.clock.advance(61 * 24 * 60 * 60 * 1000)
    expect(await deps.store.activeStrikePoints(USER_A)).toBe(0)
  })

  it('revoking twice returns null the second time', async () => {
    const deps = makeDeps()
    const { strikeId } = await addStrike(deps.store, deps.notifier, { userId: USER_A, severity: 'info', reason: 'a', source: 'system', actorId: null, moderationEventId: null, caseId: null }, deps.config, deps.clock)
    expect(await revokeStrike(deps.store, strikeId as string, null, 'system', null)).toBeTruthy()
    expect(await revokeStrike(deps.store, strikeId as string, null, 'system', null)).toBeNull()
  })
})

describe('override tracking', () => {
  async function withAutomatedEvent(deps: TestDeps, details: Record<string, unknown>) {
    const content = deps.store.addContent({ ownerId: USER_A })
    const eventId = await deps.store.insertEvent({
      targetType: 'content',
      targetId: content.id,
      eventType: 'ai_flag',
      source: 'automated',
      severity: 'violation',
      summary: null,
      details,
      actorId: null,
      caseId: null,
      priorState: null,
    })
    return { content, eventId }
  }

  it('records a mod_note when a human approves what automation would have held', async () => {
    const deps = makeDeps()
    const { content, eventId } = await withAutomatedEvent(deps, { action: 'shadow_only', would_have: 'remove_or_hold' })
    await applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'approve' }), deps.config, deps.clock)
    const override = (await deps.store.listEvents('content', content.id, 10)).find((e) => e.details['action'] === 'override')
    expect(override).toMatchObject({ eventType: 'mod_note', source: 'moderator', actorId: REVIEWER_A })
    expect(override?.details).toMatchObject({ overrides_event_id: eventId, automated_action: 'remove_or_hold', human_action: 'approve' })
  })

  it('records an override when a human removes what automation allowed', async () => {
    const deps = makeDeps()
    const { content } = await withAutomatedEvent(deps, { action: 'auto_allow' })
    await applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'remove', reason: 'spam' }), deps.config, deps.clock)
    expect((await deps.store.listEvents('content', content.id, 10)).some((e) => e.details['action'] === 'override')).toBe(true)
  })

  it('writes nothing when the human agrees or when no automated event exists', async () => {
    const deps = makeDeps()
    const { content } = await withAutomatedEvent(deps, { action: 'shadow_only', would_have: 'remove_or_hold' })
    await applyModerationAction(deps.store, deps.notifier, action({ targetId: content.id, op: 'remove', reason: 'spam' }), deps.config, deps.clock)
    expect((await deps.store.listEvents('content', content.id, 10)).some((e) => e.details['action'] === 'override')).toBe(false)

    const plain = deps.store.addContent({ ownerId: USER_A })
    await applyModerationAction(deps.store, deps.notifier, action({ targetId: plain.id, op: 'approve' }), deps.config, deps.clock)
    expect((await deps.store.listEvents('content', plain.id, 10)).map((e) => e.eventType)).toEqual(['content_approve'])
  })
})

describe('logUserLookup', () => {
  it('writes once per debounce window', async () => {
    const deps = makeDeps()
    expect(await logUserLookup(deps.store, ADMIN_A, USER_A, deps.config, deps.clock)).toBeTruthy()
    expect(await logUserLookup(deps.store, ADMIN_A, USER_A, deps.config, deps.clock)).toBeNull()
    deps.clock.advance(deps.config.userLookupDebounceMs + 1)
    expect(await logUserLookup(deps.store, ADMIN_A, USER_A, deps.config, deps.clock)).toBeTruthy()
  })
})

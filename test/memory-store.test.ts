import { describe, expect, it } from 'vitest'
import { addStrike } from '../src/actions.js'
import { ADMIN_A, REVIEWER_A, USER_A, USER_B, hoursAgo, makeDeps, reputation, type TestDeps } from './helpers.js'

const NEW_USER = '55555555-5555-4555-8555-555555555555'

function report(d: TestDeps, reporterId: string, targetId: string) {
  return d.store.fileReport({ reporterId, targetId, reason: 'spam', evidencePaths: [] })
}

describe('fileReport guards', () => {
  it('refuses a reporter younger than the minimum age', async () => {
    const d = makeDeps()
    d.store.addUser({ id: NEW_USER, createdAt: hoursAgo(1) })
    const content = d.store.addContent({ ownerId: USER_A })
    await expect(report(d, NEW_USER, content.id)).rejects.toMatchObject({ code: 'account_too_new' })
  })

  it('refuses a self report', async () => {
    const d = makeDeps()
    const content = d.store.addContent({ ownerId: USER_A })
    await expect(report(d, USER_A, content.id)).rejects.toMatchObject({ code: 'self_report' })
  })

  it('refuses a duplicate open report and a missing target', async () => {
    const d = makeDeps()
    const content = d.store.addContent({ ownerId: USER_A })
    await report(d, USER_B, content.id)
    await expect(report(d, USER_B, content.id)).rejects.toMatchObject({ code: 'duplicate_report' })
    await expect(report(d, USER_B, 'missing')).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses malformed evidence and over-length reasons', async () => {
    const d = makeDeps()
    const content = d.store.addContent({ ownerId: USER_A })
    const reporter = '66666666-6666-4666-8666-666666666666'
    d.store.addUser({ id: reporter, createdAt: hoursAgo(1000) })
    for (const path of ['../x', 'evidence/../x', 'a//b', 'a/', '/a', './a']) {
      await expect(d.store.fileReport({ reporterId: reporter, targetId: content.id, reason: null, evidencePaths: [path] }), path).rejects.toMatchObject({ code: 'invalid_input' })
    }
    await expect(d.store.fileReport({ reporterId: USER_B, targetId: content.id, reason: 'x'.repeat(501), evidencePaths: [] })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('reads a held or removed target as not_found', async () => {
    const d = makeDeps()
    const held = d.store.addContent({ ownerId: USER_A, moderationState: 'held' })
    const removed = d.store.addContent({ ownerId: USER_A, moderationState: 'removed' })
    await expect(report(d, USER_B, held.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(report(d, USER_B, removed.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('rate limits reports per reporter', async () => {
    const d = makeDeps()
    for (let i = 0; i < d.config.settings.reportRateMax; i += 1) {
      await report(d, USER_B, d.store.addContent({ ownerId: USER_A }).id)
    }
    await expect(report(d, USER_B, d.store.addContent({ ownerId: USER_A }).id)).rejects.toMatchObject({ code: 'rate_limited' })
  })

  it('opens one case per target, stamps the reporter reach as trust weight and auto-hides at the weight', async () => {
    const d = makeDeps({ settings: { autoHideWeight: 1.5 } })
    d.store.setReputation(reputation({ user_id: USER_B, account_created_at: hoursAgo(5000) }))
    d.store.setReputation(reputation({ user_id: REVIEWER_A, account_created_at: hoursAgo(5000) }))
    const content = d.store.addContent({ ownerId: USER_A })
    await report(d, USER_B, content.id)
    const first = await d.store.openCaseFor(content.id)
    expect(first?.state).toBe('open')
    expect((await d.store.listReports(content.id))[0]).toMatchObject({ caseId: first?.id, trustWeight: 0.8, state: 'open' })
    expect(d.store.getContent(content.id)?.moderationState).toBe('visible')

    await report(d, REVIEWER_A, content.id)
    expect((await d.store.openCaseFor(content.id))?.id).toBe(first?.id)
    expect(d.store.getContent(content.id)?.moderationState).toBe('held')
    const holds = (await d.store.listEvents('content', content.id, 10)).filter((e) => e.eventType === 'content_hold')
    expect(holds).toHaveLength(1)
    expect(holds[0]).toMatchObject({
      source: 'system',
      severity: 'warning',
      priorState: 'visible',
      caseId: first?.id,
      actorId: null,
      details: { reason: 'auto_hide', weight_sum: 1.6, threshold: 1.5 },
    })
  })

  it('uses trust weight 1.0 when reach is disabled in settings', async () => {
    const d = makeDeps({ settings: { reachEnabled: false } })
    const content = d.store.addContent({ ownerId: USER_A })
    await report(d, USER_B, content.id)
    expect((await d.store.listReports(content.id))[0]?.trustWeight).toBe(1)
  })
})

describe('cases', () => {
  it('a held state opens a case and openCase returns the existing one', async () => {
    const d = makeDeps()
    const content = d.store.addContent({ ownerId: USER_A })
    expect(await d.store.openCaseFor(content.id)).toBeNull()
    expect(await d.store.setContentState(content.id, 'held')).toBe('visible')
    const opened = await d.store.openCaseFor(content.id)
    expect(opened).not.toBeNull()
    expect((await d.store.openCase(content.id)).id).toBe(opened?.id)
    expect(await d.store.setContentState('missing', 'held')).toBeNull()
  })

  it('claim and release respect ownership unless forced', async () => {
    const d = makeDeps()
    const caseRow = await d.store.openCase(d.store.addContent({ ownerId: USER_A }).id)
    await d.store.claimCase(caseRow.id, REVIEWER_A, false)
    await expect(d.store.claimCase(caseRow.id, ADMIN_A, false)).rejects.toMatchObject({ code: 'case_claimed_by_other' })
    await expect(d.store.releaseCase(caseRow.id, ADMIN_A, false)).rejects.toMatchObject({ code: 'forbidden' })
    expect((await d.store.claimCase(caseRow.id, ADMIN_A, true)).claimedBy).toBe(ADMIN_A)
    expect((await d.store.releaseCase(caseRow.id, ADMIN_A, false)).state).toBe('open')
  })

  it('a decided case cannot be decided again except by restore, which reverses it', async () => {
    const d = makeDeps()
    const content = d.store.addContent({ ownerId: USER_A })
    const caseRow = await d.store.openCase(content.id)
    const decide = (decision: 'keep' | 'remove' | 'restore') =>
      d.store.decideCase({ caseId: caseRow.id, decision, flagJustified: null, actorId: REVIEWER_A, source: 'moderator', reason: null })
    await decide('remove')
    expect(d.store.getContent(content.id)?.moderationState).toBe('removed')
    await expect(decide('keep')).rejects.toMatchObject({ code: 'case_not_open' })
    await expect(d.store.claimCase(caseRow.id, REVIEWER_A, false)).rejects.toMatchObject({ code: 'case_not_open' })
    const restored = await decide('restore')
    expect(restored).toMatchObject({ decision: 'restore', priorState: 'removed', moderationState: 'visible' })
    expect((await d.store.getCase(caseRow.id))?.state).toBe('reversed')
    expect((await d.store.getEvent(restored.eventId))?.eventType).toBe('content_restore')
    await expect(decide('restore')).rejects.toMatchObject({ code: 'case_not_open' })
  })

  it('restore needs a remove ruling, the latest case for the target and removed content', async () => {
    const d = makeDeps()
    const decide = (caseId: string, decision: 'keep' | 'remove' | 'restore') =>
      d.store.decideCase({ caseId, decision, flagJustified: null, actorId: REVIEWER_A, source: 'moderator', reason: null })

    const kept = d.store.addContent({ ownerId: USER_A })
    const keepCase = await d.store.openCase(kept.id)
    await decide(keepCase.id, 'keep')
    await expect(decide(keepCase.id, 'restore')).rejects.toMatchObject({ code: 'case_not_open' })

    const twice = d.store.addContent({ ownerId: USER_A })
    const first = await d.store.openCase(twice.id)
    await decide(first.id, 'remove')
    d.clock.advance(1000)
    const second = await d.store.openCase(twice.id)
    await decide(second.id, 'remove')
    await expect(decide(first.id, 'restore')).rejects.toMatchObject({ code: 'case_not_open' })
    expect(d.store.getContent(twice.id)?.moderationState).toBe('removed')
    expect((await decide(second.id, 'restore')).moderationState).toBe('visible')

    const reinstated = d.store.addContent({ ownerId: USER_A })
    const removeCase = await d.store.openCase(reinstated.id)
    await decide(removeCase.id, 'remove')
    await d.store.setContentState(reinstated.id, 'visible')
    await expect(decide(removeCase.id, 'restore')).rejects.toMatchObject({ code: 'case_not_open' })
  })
})

describe('fileAppeal guards', () => {
  async function strikeFor(d: TestDeps, userId: string) {
    const { strikeId } = await addStrike(d.store, d.notifier, { userId, severity: 'violation', reason: 'r', source: 'moderator', actorId: REVIEWER_A, moderationEventId: null, caseId: null }, d.config, d.clock)
    return strikeId as string
  }

  it('refuses an appeal on another member strike', async () => {
    const d = makeDeps()
    const strikeId = await strikeFor(d, USER_A)
    await expect(d.store.fileAppeal({ userId: USER_B, strikeId, statement: 'this was not me at all' })).rejects.toMatchObject({ code: 'not_strike_owner' })
  })

  it('refuses a second pending appeal, a short statement and an inactive strike', async () => {
    const d = makeDeps()
    const strikeId = await strikeFor(d, USER_A)
    const appealId = await d.store.fileAppeal({ userId: USER_A, strikeId, statement: 'please take another look' })
    expect((await d.store.listEvents('user', USER_A, 10))[0]).toMatchObject({ eventType: 'appeal_filed', details: { appeal_id: appealId, strike_id: strikeId } })
    await expect(d.store.fileAppeal({ userId: USER_A, strikeId, statement: 'please take another look' })).rejects.toMatchObject({ code: 'duplicate_appeal' })
    await expect(d.store.fileAppeal({ userId: USER_A, strikeId: await strikeFor(d, USER_A), statement: 'short' })).rejects.toMatchObject({ code: 'invalid_input' })
    await d.store.revokeStrike(strikeId, ADMIN_A)
    await d.store.resolveAppeal(appealId, 'overturn', ADMIN_A, null)
    await expect(d.store.fileAppeal({ userId: USER_A, strikeId, statement: 'please take another look' })).rejects.toMatchObject({ code: 'strike_inactive' })
    await expect(d.store.resolveAppeal(appealId, 'uphold', ADMIN_A, null)).rejects.toMatchObject({ code: 'appeal_not_pending' })
  })
})

describe('readQueue', () => {
  it('shapes identity, orders by priority and refuses the owner filter without identity', async () => {
    const d = makeDeps()
    d.store.setRole({ userId: USER_A, role: 'member', displayName: 'Member One' })
    const plain = d.store.addContent({ ownerId: USER_A, body: 'first' })
    await d.store.openCase(plain.id)
    d.clock.advance(1000)
    const held = d.store.addContent({ ownerId: USER_A, body: 'second' })
    await report(d, USER_B, held.id)
    await d.store.setContentState(held.id, 'held')

    const forAdmin = await d.store.readQueue({ filter: 'open', callerId: ADMIN_A, ownerId: null, includeIdentity: true, limit: 10 })
    expect(forAdmin.map((i) => i.contentId)).toEqual([held.id, plain.id])
    expect(forAdmin[0]).toMatchObject({ priority: 1, ownerId: USER_A, ownerDisplayName: 'Member One', openReportCount: 1, preview: 'second' })
    expect(forAdmin[0]?.reports[0]?.reporterId).toBe(USER_B)

    const forModerator = await d.store.readQueue({ filter: 'open', callerId: REVIEWER_A, ownerId: null, includeIdentity: false, limit: 10 })
    expect(forModerator[0]).toMatchObject({ ownerId: null, ownerDisplayName: null })
    expect(forModerator[0]?.reports[0]?.reporterId).toBeNull()

    await expect(d.store.readQueue({ filter: 'open', callerId: REVIEWER_A, ownerId: USER_A, includeIdentity: false, limit: 10 })).rejects.toMatchObject({ code: 'forbidden' })
  })
})

describe('settings', () => {
  it('refuses full_auto without an acknowledgement', async () => {
    const d = makeDeps()
    await expect(d.store.saveSettings({ automationLevel: 'full_auto' }, ADMIN_A)).rejects.toMatchObject({ code: 'invalid_input' })
    const saved = await d.store.saveSettings({ automationLevel: 'full_auto', fullAutoAcknowledgedAt: hoursAgo(0) }, ADMIN_A)
    expect(saved).toMatchObject({ automationLevel: 'full_auto', updatedBy: ADMIN_A })
  })
})

// Appeals: ownership is checked in SQL, overturn restores through the case
// and revokes the strike, uphold leaves the strike in place.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSupabaseStore, type SupabaseStore } from '../../src/supabase/store.js'
import { fileAppeal, listPendingAppeals, resolveAppeal } from '../../src/supabase/appeals.js'
import type { Settings } from '../../src/types.js'
import { ANON_KEY, Fixtures, codeOf, contentState, recordingNotifier, serviceClient, userClient, type TestUser } from './helpers.js'

const client = serviceClient()
const store: SupabaseStore = createSupabaseStore(client, { onError: () => {} })
const fx = new Fixtures(client)

let admin: TestUser
let moderator: TestUser
let other: TestUser
let original: Settings

const STATEMENT = 'I believe this strike was a mistake and ask for a second look.'

beforeAll(async () => {
  admin = await fx.user('admin', 'admin')
  moderator = await fx.user('moderator', 'moderator')
  other = await fx.user('other')
  original = await store.loadSettings()
  await store.saveSettings({ reportMinAccountAgeHours: 0 }, admin.id)
})

afterAll(async () => {
  await store.saveSettings({ reportMinAccountAgeHours: original.reportMinAccountAgeHours }, admin.id)
  await fx.cleanup()
})

interface Scenario {
  owner: TestUser
  contentId: string
  caseId: string
  strikeId: string
}

/** A fresh owner whose reported post was removed through a case, with a strike off that event. */
async function removedWithStrike(body: string): Promise<Scenario> {
  const owner = await fx.user('owner')
  const reporter = await fx.user('reporter')
  const contentId = await fx.content(owner.id, body)
  await store.fileReport({ reporterId: reporter.id, targetId: contentId, reason: 'rule break', evidencePaths: [] })
  const openCase = await store.openCaseFor(contentId)
  const decision = await store.decideCase({
    caseId: openCase!.id,
    decision: 'remove',
    flagJustified: true,
    actorId: moderator.id,
    source: 'moderator',
    reason: 'removed',
  })
  const strikeId = await store.insertStrike({
    userId: owner.id,
    severity: 'violation',
    points: 3,
    reason: 'removed post',
    expiresAt: null,
    moderationEventId: decision.eventId,
  })
  return { owner, contentId, caseId: openCase!.id, strikeId: strikeId! }
}

describe('filing', () => {
  it('a forged appeal on another user\'s strike raises not_strike_owner', async () => {
    const { strikeId } = await removedWithStrike('forged appeal target')
    expect(await codeOf(() => fileAppeal(store, other.id, strikeId, STATEMENT))).toBe('not_strike_owner')
  })

  it.skipIf(!ANON_KEY)('file_appeal as authenticated uses auth.uid(), so another member cannot appeal it', async () => {
    const { owner, strikeId } = await removedWithStrike('forged appeal via rpc')
    const asOther = await userClient(other)
    const { error } = await asOther.rpc('file_appeal', { p_strike_id: strikeId, p_statement: STATEMENT })
    expect(error?.code).toBe('MQ010')
    const asOwner = await userClient(owner)
    const { data, error: ownError } = await asOwner.rpc('file_appeal', { p_strike_id: strikeId, p_statement: STATEMENT })
    expect(ownError).toBeNull()
    const appeal = await store.getAppeal(String(data))
    expect(appeal?.userId).toBe(owner.id)
    expect(appeal?.state).toBe('pending')
  })

  it('refuses a short statement, a second pending appeal and an unknown strike', async () => {
    const { owner, strikeId } = await removedWithStrike('appeal guards')
    expect(await codeOf(() => fileAppeal(store, owner.id, strikeId, 'too short'))).toBe('invalid_input')
    const appealId = await fileAppeal(store, owner.id, strikeId, STATEMENT)
    expect((await listPendingAppeals(store)).some((a) => a.id === appealId)).toBe(true)
    expect(await codeOf(() => fileAppeal(store, owner.id, strikeId, STATEMENT))).toBe('duplicate_appeal')
    expect(await codeOf(() => fileAppeal(store, owner.id, '00000000-0000-0000-0000-000000000000', STATEMENT))).toBe('not_found')
  })

  it('refuses an appeal on a revoked strike', async () => {
    const { owner, strikeId } = await removedWithStrike('revoked strike')
    await store.revokeStrike(strikeId, admin.id)
    expect(await codeOf(() => fileAppeal(store, owner.id, strikeId, STATEMENT))).toBe('strike_inactive')
  })
})

describe('resolving', () => {
  it('overturn revokes the strike and restores the content through the case', async () => {
    const { owner, contentId, caseId, strikeId } = await removedWithStrike('overturned removal')
    const appealId = await fileAppeal(store, owner.id, strikeId, STATEMENT)
    const notifier = recordingNotifier()

    const result = await resolveAppeal(store, notifier, {
      appealId,
      resolution: 'overturn',
      actorId: admin.id,
      actorRole: 'admin',
      note: 'on reflection the post was fine',
    })

    expect(result.appeal.state).toBe('overturned')
    expect(result.appeal.resolvedBy).toBe(admin.id)
    expect(result.strikeRevoked).toBe(true)
    expect(result.decision?.decision).toBe('restore')
    expect(result.decision?.priorState).toBe('removed')
    expect(result.decision?.moderationState).toBe('visible')
    expect(await contentState(client, contentId)).toBe('visible')
    expect((await store.getCase(caseId))?.state).toBe('reversed')
    expect((await store.getStrike(strikeId))?.revokedAt).not.toBeNull()
    expect(await store.activeStrikePoints(owner.id)).toBe(0)

    const contentEvents = await store.listEvents('content', contentId, 10)
    const restore = contentEvents.find((e) => e.eventType === 'content_restore')
    expect(restore?.source).toBe('admin')
    expect(restore?.actorId).toBe(admin.id)
    const userEvents = await store.listEvents('user', owner.id, 10)
    expect(userEvents.map((e) => e.eventType)).toContain('strike_revoked')
    expect(userEvents.map((e) => e.eventType)).toContain('appeal_resolved')

    expect(notifier.appeals).toEqual([{ userId: owner.id, appealId, resolution: 'overturn', messageKey: 'appeal_overturned' }])
  })

  it('uphold marks the appeal and keeps the strike active', async () => {
    const { owner, contentId, strikeId } = await removedWithStrike('upheld removal')
    const appealId = await fileAppeal(store, owner.id, strikeId, STATEMENT)
    const notifier = recordingNotifier()

    const result = await resolveAppeal(store, notifier, {
      appealId,
      resolution: 'uphold',
      actorId: moderator.id,
      actorRole: 'moderator',
      note: null,
    })
    expect(result.appeal.state).toBe('upheld')
    expect(result.strikeRevoked).toBe(false)
    expect(result.decision).toBeNull()
    expect(await contentState(client, contentId)).toBe('removed')
    expect((await store.getStrike(strikeId))?.revokedAt).toBeNull()
    expect(notifier.appeals[0]?.messageKey).toBe('appeal_upheld')

    expect(
      await codeOf(() => resolveAppeal(store, notifier, { appealId, resolution: 'overturn', actorId: admin.id, actorRole: 'admin', note: null })),
    ).toBe('appeal_not_pending')
  })

  it('overturn of a strike with no case revokes only', async () => {
    const owner = await fx.user('warned')
    const strikeId = await store.insertStrike({
      userId: owner.id,
      severity: 'warning',
      points: 2,
      reason: 'a warning with no case',
      expiresAt: null,
      moderationEventId: null,
    })
    const appealId = await fileAppeal(store, owner.id, strikeId!, STATEMENT)
    const result = await resolveAppeal(store, recordingNotifier(), {
      appealId,
      resolution: 'overturn',
      actorId: admin.id,
      actorRole: 'admin',
      note: null,
    })
    expect(result.strikeRevoked).toBe(true)
    expect(result.decision).toBeNull()
  })

  it('a notifier failure does not undo the resolution', async () => {
    const { owner, strikeId } = await removedWithStrike('notifier failure')
    const appealId = await fileAppeal(store, owner.id, strikeId, STATEMENT)
    const failing = { ...recordingNotifier(), onAppealResolved: async () => { throw new Error('mail is down') } }
    const errors: string[] = []
    const result = await resolveAppeal(store, failing, {
      appealId,
      resolution: 'uphold',
      actorId: admin.id,
      actorRole: 'admin',
      note: null,
      onError: (context) => errors.push(context),
    })
    expect(result.appeal.state).toBe('upheld')
    expect(errors).toEqual(['notifier.onAppealResolved'])
  })
})

import { describe, expect, it } from 'vitest'
import { loadQueue, shapeQueueItems } from '../src/supabase/queue.js'
import { mapDbError } from '../src/supabase/store.js'
import { ADMIN_A, REVIEWER_A, USER_A, makeDeps } from './helpers.js'

describe('queue identity shaping', () => {
  it('nulls the actor on member and system events for a moderator and keeps every actor for an admin', async () => {
    const d = makeDeps()
    const content = d.store.addContent({ ownerId: USER_A, body: 'tripped post' })
    await d.store.openCase(content.id)
    const base = { targetType: 'content' as const, targetId: content.id, severity: 'info' as const, summary: null, details: {}, caseId: null, priorState: null }
    await d.store.insertEvent({ ...base, eventType: 'tripwire', source: 'system', actorId: USER_A })
    await d.store.insertEvent({ ...base, eventType: 'appeal_filed', source: 'member', actorId: USER_A })
    await d.store.insertEvent({ ...base, eventType: 'content_hold', source: 'moderator', actorId: REVIEWER_A })

    const asModerator = await loadQueue(d.store, { filter: 'open', claimed: null, userId: null, callerId: REVIEWER_A, callerRole: 'moderator' })
    const byType = (events: { eventType: string; actorId: string | null }[]) => Object.fromEntries(events.map((e) => [e.eventType, e.actorId]))
    expect(byType(asModerator[0]!.events)).toEqual({ tripwire: null, appeal_filed: null, content_hold: REVIEWER_A })

    const asAdmin = await loadQueue(d.store, { filter: 'open', claimed: null, userId: null, callerId: ADMIN_A, callerRole: 'admin' })
    expect(byType(asAdmin[0]!.events)).toEqual({ tripwire: USER_A, appeal_filed: USER_A, content_hold: REVIEWER_A })
    expect(byType(shapeQueueItems(asAdmin, false)[0]!.events)).toEqual(byType(asModerator[0]!.events))
  })
})

describe('mapDbError', () => {
  it('maps a unique violation to invalid_input without the constraint name', () => {
    const error = mapDbError({ code: '23505', message: 'duplicate key value violates unique constraint "moderation_reports_one_open_idx"', details: 'Key (reporter_id, target_id)=(a, b) already exists.' })
    expect(error.code).toBe('invalid_input')
    expect(error.message).not.toContain('moderation_reports_one_open_idx')
    expect(error.message).not.toContain('reporter_id')
  })

  it('maps the kit SQLSTATEs and check violations, and keeps the rest as store_error', () => {
    expect(mapDbError({ code: 'MQ008', message: 'duplicate_report' }).code).toBe('duplicate_report')
    expect(mapDbError({ code: '23514', message: 'check' }).code).toBe('invalid_input')
    expect(mapDbError({ code: 'P0001', message: 'not_found' }).code).toBe('not_found')
    expect(mapDbError({ code: '42501', message: 'permission denied' }).code).toBe('store_error')
  })
})

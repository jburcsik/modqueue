// The action spine end to end against a local Supabase: a report files, the
// queue shows it, decisions settle the case, resolve reports and write one
// event; the report guards refuse what the contract says they refuse.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSupabaseStore, type SupabaseStore } from '../../src/supabase/store.js'
import { loadQueue } from '../../src/supabase/queue.js'
import type { Settings } from '../../src/types.js'
import { ANON_KEY, Fixtures, codeOf, contentState, serviceClient, userClient, type TestUser } from './helpers.js'

const client = serviceClient()
const store: SupabaseStore = createSupabaseStore(client, { onError: () => {} })
const fx = new Fixtures(client)

let admin: TestUser
let moderator: TestUser
let owner: TestUser
let reporter: TestUser
let original: Settings

beforeAll(async () => {
  admin = await fx.user('admin', 'admin')
  moderator = await fx.user('moderator', 'moderator')
  owner = await fx.user('owner')
  reporter = await fx.user('reporter')
  original = await store.loadSettings()
  await store.saveSettings({ reportMinAccountAgeHours: 0 }, admin.id)
})

afterAll(async () => {
  await store.saveSettings({ reportMinAccountAgeHours: original.reportMinAccountAgeHours }, admin.id)
  await fx.cleanup()
})

describe('report, queue, decide', () => {
  it('a report opens a case that the queue shows, and remove settles it with one event', async () => {
    const contentId = await fx.content(owner.id, 'a post that gets reported')

    const reportId = await store.fileReport({ reporterId: reporter.id, targetId: contentId, reason: 'off topic', evidencePaths: [] })
    expect(reportId).toMatch(/^[0-9a-f-]{36}$/)

    const openCase = await store.openCaseFor(contentId)
    expect(openCase).not.toBeNull()

    const queue = await loadQueue(store, { filter: 'open', claimed: null, userId: null, callerId: moderator.id, callerRole: 'moderator' })
    const item = queue.find((q) => q.contentId === contentId)
    expect(item).toBeDefined()
    expect(item?.openReportCount).toBe(1)
    expect(item?.reports[0]?.id).toBe(reportId)

    const result = await store.decideCase({
      caseId: openCase!.id,
      decision: 'remove',
      flagJustified: true,
      actorId: moderator.id,
      source: 'moderator',
      reason: 'breaks the rules',
    })
    expect(result.decision).toBe('remove')
    expect(result.priorState).toBe('visible')
    expect(result.moderationState).toBe('removed')
    expect(result.reportsResolved).toBe(1)
    expect(await contentState(client, contentId)).toBe('removed')

    const reports = await store.listReports(contentId)
    expect(reports.map((r) => r.state)).toEqual(['upheld'])
    expect(reports[0]?.resolvedAt).not.toBeNull()

    const events = await store.listEvents('content', contentId, 10)
    const removes = events.filter((e) => e.eventType === 'content_remove')
    expect(removes).toHaveLength(1)
    expect(removes[0]?.source).toBe('moderator')
    expect(removes[0]?.actorId).toBe(moderator.id)
    expect(removes[0]?.caseId).toBe(openCase!.id)
    expect(removes[0]?.priorState).toBe('visible')
    expect(removes[0]?.id).toBe(result.eventId)

    const settled = await store.getCase(openCase!.id)
    expect(settled?.state).toBe('decided')
    expect(settled?.decision).toBe('remove')
    expect(await store.openCaseFor(contentId)).toBeNull()
  })

  it('approve keeps the content visible, resolves reports upheld and writes content_approve', async () => {
    const contentId = await fx.content(owner.id, 'held then approved', 'held')
    const openCase = await store.openCaseFor(contentId)
    expect(openCase, 'held content opens a case by trigger').not.toBeNull()

    const result = await store.decideCase({
      caseId: openCase!.id,
      decision: 'keep',
      flagJustified: null,
      actorId: admin.id,
      source: 'admin',
      reason: null,
    })
    expect(result.priorState).toBe('held')
    expect(result.moderationState).toBe('visible')
    const events = await store.listEvents('content', contentId, 10)
    expect(events.filter((e) => e.eventType === 'content_approve')).toHaveLength(1)
    expect(events[0]?.source).toBe('admin')
  })

  it('dismiss keeps the content and records the report as rejected', async () => {
    const contentId = await fx.content(owner.id, 'reported without cause')
    await store.fileReport({ reporterId: reporter.id, targetId: contentId, reason: null, evidencePaths: [] })
    const openCase = await store.openCaseFor(contentId)

    const result = await store.decideCase({
      caseId: openCase!.id,
      decision: 'keep',
      flagJustified: false,
      actorId: moderator.id,
      source: 'moderator',
      reason: 'nothing wrong here',
    })
    expect(result.moderationState).toBe('visible')
    const reports = await store.listReports(contentId)
    expect(reports.map((r) => r.state)).toEqual(['rejected'])
    expect(reports, 'the report survives the decision').toHaveLength(1)
    expect(await store.openCaseFor(contentId)).toBeNull()
  })

  it('a decided case refuses a second decision with case_not_open', async () => {
    const contentId = await fx.content(owner.id, 'decided once')
    const opened = await store.openCase(contentId)
    await store.decideCase({ caseId: opened.id, decision: 'keep', flagJustified: null, actorId: admin.id, source: 'admin', reason: null })
    const code = await codeOf(() =>
      store.decideCase({ caseId: opened.id, decision: 'remove', flagJustified: true, actorId: admin.id, source: 'admin', reason: null }),
    )
    expect(code).toBe('case_not_open')
  })

  it('an unknown case is not_found', async () => {
    const code = await codeOf(() =>
      store.decideCase({
        caseId: '00000000-0000-0000-0000-000000000000',
        decision: 'keep',
        flagJustified: null,
        actorId: admin.id,
        source: 'admin',
        reason: null,
      }),
    )
    expect(code).toBe('not_found')
  })

  it('hold opens a case by trigger; warn and note write their events and leave the state alone', async () => {
    const contentId = await fx.content(owner.id, 'held by a moderator')
    const prior = await store.setContentState(contentId, 'held')
    expect(prior).toBe('visible')
    const held = await store.openCaseFor(contentId)
    expect(held).not.toBeNull()

    const warnId = await store.insertEvent({
      targetType: 'content',
      targetId: contentId,
      eventType: 'content_warn',
      source: 'moderator',
      severity: 'warning',
      summary: 'Warned',
      details: {},
      actorId: moderator.id,
      caseId: held!.id,
      priorState: 'held',
    })
    const noteId = await store.insertEvent({
      targetType: 'content',
      targetId: contentId,
      eventType: 'mod_note',
      source: 'moderator',
      severity: 'info',
      summary: 'A note',
      details: { note: 'watch this one' },
      actorId: moderator.id,
      caseId: held!.id,
      priorState: null,
    })
    expect(warnId).not.toBeNull()
    expect(noteId).not.toBeNull()
    expect(await contentState(client, contentId)).toBe('held')
    expect((await store.getCase(held!.id))?.state).toBe('open')

    const strikeId = await store.insertStrike({
      userId: owner.id,
      severity: 'warning',
      points: 2,
      reason: 'warned',
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      moderationEventId: warnId,
    })
    expect(strikeId).not.toBeNull()
    expect(await store.activeStrikePoints(owner.id)).toBe(2)
    expect(await store.activeStrikeCount(owner.id)).toBe(1)
    expect(await store.revokeStrike(strikeId!, admin.id)).not.toBeNull()
    expect(await store.revokeStrike(strikeId!, admin.id), 'a second revoke finds nothing').toBeNull()
    expect(await store.activeStrikePoints(owner.id)).toBe(0)
  })

  it('setContentState on a missing row returns null and a failed audit insert returns null', async () => {
    expect(await store.setContentState('00000000-0000-0000-0000-000000000000', 'held')).toBeNull()
    const id = await store.insertEvent({
      targetType: 'content',
      targetId: 'not-a-uuid',
      eventType: 'mod_note',
      source: 'system',
      severity: 'info',
      summary: null,
      details: {},
      actorId: null,
      caseId: null,
      priorState: null,
    })
    expect(id).toBeNull()
  })

  it('resolveReport moves an open report to withdrawn and refuses a second time', async () => {
    const contentId = await fx.content(owner.id, 'withdrawn report')
    const reportId = await store.fileReport({ reporterId: reporter.id, targetId: contentId, reason: 'oops', evidencePaths: [] })
    const row = await store.resolveReport(reportId, 'withdrawn', admin.id)
    expect(row.state).toBe('withdrawn')
    expect(await codeOf(() => store.resolveReport(reportId, 'duplicate', admin.id))).toBe('not_found')
  })
})

describe('file_report guards', () => {
  it('rejects self-report', async () => {
    const contentId = await fx.content(owner.id, 'my own post')
    expect(await codeOf(() => store.fileReport({ reporterId: owner.id, targetId: contentId, reason: null, evidencePaths: [] }))).toBe(
      'self_report',
    )
  })

  it('rejects an under-age account', async () => {
    const contentId = await fx.content(owner.id, 'reported by a new account')
    const young = await fx.user('young')
    await store.saveSettings({ reportMinAccountAgeHours: 1000 }, admin.id)
    try {
      expect(await codeOf(() => store.fileReport({ reporterId: young.id, targetId: contentId, reason: null, evidencePaths: [] }))).toBe(
        'account_too_new',
      )
    } finally {
      await store.saveSettings({ reportMinAccountAgeHours: 0 }, admin.id)
    }
  })

  it('rejects a duplicate open report from the same reporter', async () => {
    const contentId = await fx.content(owner.id, 'reported twice')
    const twice = await fx.user('twice')
    await store.fileReport({ reporterId: twice.id, targetId: contentId, reason: null, evidencePaths: [] })
    expect(await codeOf(() => store.fileReport({ reporterId: twice.id, targetId: contentId, reason: null, evidencePaths: [] }))).toBe(
      'duplicate_report',
    )
  })

  it('rejects a malformed evidence path, too many paths, a long reason and an unknown target', async () => {
    const contentId = await fx.content(owner.id, 'bad evidence')
    const guard = await fx.user('guard')
    const attempt = (reason: string | null, evidencePaths: string[]) =>
      codeOf(() => store.fileReport({ reporterId: guard.id, targetId: contentId, reason, evidencePaths }))
    expect(await attempt(null, ['../outside'])).toBe('invalid_input')
    expect(await attempt(null, ['a/1', 'a/2', 'a/3'])).toBe('invalid_input')
    expect(await attempt('x'.repeat(501), [])).toBe('invalid_input')
    expect(
      await codeOf(() =>
        store.fileReport({ reporterId: guard.id, targetId: '00000000-0000-0000-0000-000000000000', reason: null, evidencePaths: [] }),
      ),
    ).toBe('not_found')
  })

  it.skipIf(!ANON_KEY)('a direct insert into moderation_reports as authenticated is denied', async () => {
    const contentId = await fx.content(owner.id, 'direct insert target')
    const member = await fx.user('member')
    const asMember = await userClient(member)
    const { error } = await asMember
      .from('moderation_reports')
      .insert({ target_id: contentId, reporter_id: member.id, reason: 'forged', trust_weight: 1 })
    expect(error).not.toBeNull()
    const { data } = await client.from('moderation_reports').select('id').eq('target_id', contentId)
    expect(data).toHaveLength(0)
  })

  it.skipIf(!ANON_KEY)('file_report as authenticated files for auth.uid() only', async () => {
    const contentId = await fx.content(owner.id, 'reported through the client function')
    const member = await fx.user('member')
    const asMember = await userClient(member)
    const { data, error } = await asMember.rpc('file_report', { p_target_id: contentId, p_reason: 'via rpc', p_evidence_paths: [] })
    expect(error).toBeNull()
    const reports = await store.listReports(contentId)
    expect(reports.map((r) => r.id)).toEqual([String(data)])
    expect(reports[0]?.reporterId).toBe(member.id)
  })
})

describe('trust-weighted auto-hide', () => {
  it('holds the content and opens a case once open report weights reach auto_hide_weight', async () => {
    const settings = await store.loadSettings()
    const contentId = await fx.content(owner.id, 'piling up reports')
    let sum = 0
    let held = false
    for (let i = 0; i < 12 && !held; i += 1) {
      const user = await fx.user(`reporter${i}`)
      await store.fileReport({ reporterId: user.id, targetId: contentId, reason: null, evidencePaths: [] })
      const reports = await store.listReports(contentId)
      sum = reports.filter((r) => r.state === 'open').reduce((acc, r) => acc + r.trustWeight, 0)
      const state = await contentState(client, contentId)
      if (sum >= settings.autoHideWeight) {
        expect(state).toBe('held')
        held = true
      } else {
        expect(state).toBe('visible')
      }
    }
    expect(held, `weights summed to ${sum} against ${settings.autoHideWeight}`).toBe(true)
    const openCase = await store.openCaseFor(contentId)
    expect(openCase?.state).toBe('open')
    const reports = await store.listReports(contentId)
    expect(reports.every((r) => r.caseId === openCase?.id)).toBe(true)
    const holds = (await store.listEvents('content', contentId, 20)).filter((e) => e.eventType === 'content_hold')
    expect(holds).toHaveLength(1)
    expect(holds[0]?.source).toBe('system')
    expect(holds[0]?.caseId).toBe(openCase?.id)
    expect(holds[0]?.details).toMatchObject({ reason: 'auto_hide' })
  })
})

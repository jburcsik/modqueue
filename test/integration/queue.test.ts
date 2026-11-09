// Queue shaping, the user filter audit, claim, release and take-over.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSupabaseStore, type SupabaseStore } from '../../src/supabase/store.js'
import { loadQueue } from '../../src/supabase/queue.js'
import { claimCase, releaseCase, takeOverCase } from '../../src/supabase/claim.js'
import { createSupabaseAuthorizer } from '../../src/supabase/authorizer.js'
import type { Settings } from '../../src/types.js'
import { ANON_KEY, Fixtures, codeOf, serviceClient, userClient, type TestUser } from './helpers.js'

const client = serviceClient()
const store: SupabaseStore = createSupabaseStore(client, { onError: () => {} })
const fx = new Fixtures(client)

let admin: TestUser
let moderator: TestUser
let moderator2: TestUser
let owner: TestUser
let reporter: TestUser
let original: Settings
let contentId: string
let caseId: string

beforeAll(async () => {
  admin = await fx.user('admin', 'admin')
  moderator = await fx.user('moderator', 'moderator')
  moderator2 = await fx.user('moderator2', 'moderator')
  owner = await fx.user('owner')
  reporter = await fx.user('reporter')
  original = await store.loadSettings()
  await store.saveSettings({ reportMinAccountAgeHours: 0 }, admin.id)
  contentId = await fx.content(owner.id, 'a reported post in the queue')
  await store.fileReport({ reporterId: reporter.id, targetId: contentId, reason: 'reported', evidencePaths: ['evidence/one.jpg'] })
  caseId = (await store.openCaseFor(contentId))!.id
})

afterAll(async () => {
  await store.saveSettings({ reportMinAccountAgeHours: original.reportMinAccountAgeHours }, admin.id)
  await fx.cleanup()
})

describe('identity shaping', () => {
  it('a moderator never sees owner or reporter identity', async () => {
    const items = await loadQueue(store, { filter: 'open', claimed: null, userId: null, callerId: moderator.id, callerRole: 'moderator' })
    const item = items.find((q) => q.caseId === caseId)
    expect(item).toBeDefined()
    expect(item?.ownerId).toBeNull()
    expect(item?.ownerDisplayName).toBeNull()
    expect(item?.reports).toHaveLength(1)
    expect(item?.reports[0]?.reporterId).toBeNull()
    expect(item?.reports[0]?.evidencePaths).toEqual(['evidence/one.jpg'])
    expect(item?.ownerStrikePoints).toBe(0)
    expect(item?.ownerReach?.error).toBe(false)
    expect(item?.priority).toBe(3)
  })

  it('an admin sees both', async () => {
    const items = await loadQueue(store, { filter: 'open', claimed: null, userId: null, callerId: admin.id, callerRole: 'admin' })
    const item = items.find((q) => q.caseId === caseId)
    expect(item?.ownerId).toBe(owner.id)
    expect(item?.reports[0]?.reporterId).toBe(reporter.id)
  })

  it('the user filter is admin only and leaves one debounced user_lookup event', async () => {
    expect(
      await codeOf(() => loadQueue(store, { filter: 'open', claimed: null, userId: owner.id, callerId: moderator.id, callerRole: 'moderator' })),
    ).toBe('forbidden')
    expect(await codeOf(() => store.readQueue({ filter: 'open', callerId: moderator.id, ownerId: owner.id, includeIdentity: false, limit: 10 }))).toBe(
      'forbidden',
    )

    const first = await loadQueue(store, { filter: 'open', claimed: null, userId: owner.id, callerId: admin.id, callerRole: 'admin' })
    expect(first.map((q) => q.caseId)).toEqual([caseId])
    await loadQueue(store, { filter: 'open', claimed: null, userId: owner.id, callerId: admin.id, callerRole: 'admin' })
    const lookups = (await store.listEvents('user', owner.id, 10)).filter((e) => e.eventType === 'user_lookup')
    expect(lookups).toHaveLength(1)
    expect(lookups[0]?.actorId).toBe(admin.id)
    expect(lookups[0]?.source).toBe('admin')
  })

  it('held content sorts first', async () => {
    const heldId = await fx.content(owner.id, 'held content', 'held')
    const items = await loadQueue(store, { filter: 'open', claimed: null, userId: owner.id, callerId: admin.id, callerRole: 'admin' })
    expect(items[0]?.contentId).toBe(heldId)
    expect(items[0]?.priority).toBe(1)
    const decided = await loadQueue(store, { filter: 'decided', claimed: null, userId: owner.id, callerId: admin.id, callerRole: 'admin' })
    expect(decided).toHaveLength(0)
  })
})

describe('claim, release, take over', () => {
  it('follows the contract codes', async () => {
    const claimed = await claimCase(store, { caseId, actorId: moderator.id, actorRole: 'moderator' })
    expect(claimed.claimedBy).toBe(moderator.id)
    expect(claimed.state).toBe('claimed')

    expect(await codeOf(() => claimCase(store, { caseId, actorId: moderator2.id, actorRole: 'moderator' }))).toBe('case_claimed_by_other')
    expect(await codeOf(() => releaseCase(store, { caseId, actorId: moderator2.id, actorRole: 'moderator' }))).toBe('forbidden')
    expect(await codeOf(() => takeOverCase(store, { caseId, actorId: moderator2.id, actorRole: 'moderator' }))).toBe('forbidden')

    const mine = await loadQueue(store, { filter: 'mine', claimed: null, userId: null, callerId: moderator.id, callerRole: 'moderator' })
    expect(mine.map((q) => q.caseId)).toEqual([caseId])
    const byMe = await loadQueue(store, { filter: 'claimed', claimed: 'me', userId: null, callerId: moderator2.id, callerRole: 'moderator' })
    expect(byMe).toHaveLength(0)

    const taken = await takeOverCase(store, { caseId, actorId: admin.id, actorRole: 'admin' })
    expect(taken.claimedBy).toBe(admin.id)

    const released = await releaseCase(store, { caseId, actorId: admin.id, actorRole: 'admin' })
    expect(released.claimedBy).toBeNull()
    expect(released.state).toBe('open')

    await store.decideCase({ caseId, decision: 'keep', flagJustified: false, actorId: admin.id, source: 'admin', reason: null })
    expect(await codeOf(() => claimCase(store, { caseId, actorId: moderator.id, actorRole: 'moderator' }))).toBe('case_not_open')
    expect(await codeOf(() => claimCase(store, { caseId: '00000000-0000-0000-0000-000000000000', actorId: moderator.id, actorRole: 'moderator' }))).toBe(
      'not_found',
    )
  })
})

describe('roles and the authorizer', () => {
  it('reads roles; a user without a row is a member', async () => {
    expect(await store.getRole(admin.id)).toBe('admin')
    expect(await store.getRole(owner.id)).toBeNull()
    const rows = await store.listRoles([admin.id, moderator.id, owner.id])
    expect(rows.map((r) => r.role).sort()).toEqual(['admin', 'moderator'])
  })

  it.skipIf(!ANON_KEY)('requireRole resolves the session and enforces the minimum role', async () => {
    const asModerator = createSupabaseAuthorizer(await userClient(moderator), store)
    const principal = await asModerator.requireRole('moderator')
    expect(principal).toEqual({ userId: moderator.id, role: 'moderator', displayName: expect.stringMatching(/^Reviewer/) })
    expect(await codeOf(() => asModerator.requireRole('admin'))).toBe('forbidden')

    const asMember = createSupabaseAuthorizer(await userClient(owner), store)
    expect((await asMember.requireRole('member')).role).toBe('member')
    expect(await codeOf(() => asMember.requireRole('moderator'))).toBe('forbidden')

    const { createClient } = await import('@supabase/supabase-js')
    const anonymous = createSupabaseAuthorizer(createClient(process.env.SUPABASE_URL ?? 'http://127.0.0.1:54421', ANON_KEY), store)
    expect(await codeOf(() => anonymous.requireRole('member'))).toBe('unauthenticated')
  })
})

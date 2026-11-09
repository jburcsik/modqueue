// Upserts the fixture users with a known password, their roles, and a few
// queue rows, then asserts the queue has content. Idempotent.
//
//   npm run seed        (reads .env.local; SEED_PASSWORD optional)

import type { SupabaseClient } from '@supabase/supabase-js'
import { serviceClient } from '../lib/supabase/service.ts'
import { ADMIN, FIXTURE_USERS, MEMBERS, MODERATOR, SEED_CONTENT, password } from './fixtures.ts'

async function upsertUsers(admin: SupabaseClient): Promise<void> {
  const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 })
  if (error) throw error
  const byEmail = new Map(data.users.map((u) => [u.email?.toLowerCase(), u]))
  for (const fixture of FIXTURE_USERS) {
    const existing = byEmail.get(fixture.email)
    if (existing) {
      const { error } = await admin.auth.admin.updateUserById(existing.id, { password: password(), email_confirm: true })
      if (error) throw error
      if (existing.id !== fixture.id) fixture.id = existing.id
    } else {
      const { error } = await admin.auth.admin.createUser({
        id: fixture.id,
        email: fixture.email,
        password: password(),
        email_confirm: true,
        user_metadata: { display_name: fixture.displayName },
      })
      if (error) throw error
    }
  }
}

async function upsertRoles(admin: SupabaseClient): Promise<void> {
  const rows = FIXTURE_USERS.filter((u) => u.role !== 'member').map((u) => ({ user_id: u.id, role: u.role, display_name: u.displayName }))
  const { error } = await admin.from('moderation_roles').upsert(rows, { onConflict: 'user_id' })
  if (error) throw error
}

async function upsertContent(admin: SupabaseClient): Promise<void> {
  for (const row of SEED_CONTENT) {
    const owner = MEMBERS[row.owner]!
    const { data: existing } = await admin.from('moderation_content').select('id').eq('body', row.body).maybeSingle()
    if (existing) continue

    const { data: content, error } = await admin
      .from('moderation_content')
      .insert({ owner_id: owner.id, moderation_state: row.state, body: row.body })
      .select('id')
      .single()
    if (error) throw error

    // A held row opens its case by trigger; a visible row needs one for its reports.
    let { data: openCase } = await admin.from('moderation_cases').select('id').eq('target_id', content.id).in('state', ['open', 'claimed']).maybeSingle()
    if (!openCase) {
      const inserted = await admin.from('moderation_cases').insert({ target_id: content.id }).select('id').single()
      if (inserted.error) throw inserted.error
      openCase = inserted.data
    }

    const reporters = MEMBERS.filter((m) => m.id !== owner.id)
    const reports = row.reports.map((reason, i) => ({
      case_id: openCase!.id,
      target_id: content.id,
      reporter_id: reporters[i % reporters.length]!.id,
      reason,
      evidence_paths: [],
      trust_weight: 1.0,
    }))
    const inserted = await admin.from('moderation_reports').insert(reports)
    if (inserted.error) throw inserted.error
  }
}

async function main(): Promise<void> {
  const admin = serviceClient()

  await upsertUsers(admin)
  await upsertRoles(admin)
  await upsertContent(admin)

  const { count, error } = await admin.from('moderation_queue').select('case_id', { count: 'exact', head: true }).in('case_state', ['open', 'claimed'])
  if (error) throw error
  if (!count) throw new Error('the queue is empty after seeding')

  console.log(`seeded: ${FIXTURE_USERS.length} users, ${count} open cases`)
  console.log(`sign in at /login as ${MODERATOR.email} (moderator) or ${ADMIN.email} (admin), password from SEED_PASSWORD`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})

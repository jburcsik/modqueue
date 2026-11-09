import { expect, type Page } from '@playwright/test'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { env } from '../lib/env.ts'
import { serviceClient } from '../lib/supabase/service.ts'
import { MEMBERS, password } from '../scripts/fixtures.ts'

export { serviceClient }

/** An anon client signed in as a fixture member, for the client-callable functions. */
export async function memberClient(email: string): Promise<SupabaseClient> {
  const client = createClient(env.supabaseUrl(), env.anonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  const { error } = await client.auth.signInWithPassword({ email, password: password() })
  if (error) throw error
  return client
}

let usersByEmail: Map<string, string> | null = null

/** Resolves a fixture user's id from the auth service once per worker. */
export async function fixtureId(email: string): Promise<string> {
  if (!usersByEmail) {
    const { data, error } = await serviceClient().auth.admin.listUsers({ perPage: 1000 })
    if (error) throw error
    usersByEmail = new Map(data.users.flatMap((u) => (u.email ? [[u.email, u.id]] : [])))
  }
  const id = usersByEmail.get(email)
  if (!id) throw new Error(`fixture user ${email} is missing; run npm run seed`)
  return id
}

/** A throwaway member created for one test, so rate-limit windows from earlier runs never apply. */
export async function ephemeralMember(label: string): Promise<{ id: string; email: string; remove: () => Promise<void> }> {
  const admin = serviceClient()
  const email = `e2e-${label}-${Date.now()}@example.com`
  const { data, error } = await admin.auth.admin.createUser({ email, password: password(), email_confirm: true })
  if (error) throw error
  const id = data.user.id
  const { error: roleError } = await admin.from('moderation_roles').insert({ user_id: id, role: 'member', display_name: label })
  if (roleError) throw roleError
  return {
    id,
    email,
    remove: async () => {
      await admin.auth.admin.deleteUser(id)
    },
  }
}

/** Inserts one held content row for a member; the trigger opens its case. Body is prefixed `e2e-`. */
export async function heldContent(ownerEmail: string, label: string): Promise<{ contentId: string; caseId: string; ownerId: string }> {
  return heldContentFor(await fixtureId(ownerEmail), label)
}

export async function heldContentFor(ownerId: string, label: string): Promise<{ contentId: string; caseId: string; ownerId: string }> {
  const admin = serviceClient()
  const body = `e2e-${label}-${Date.now()}: text under review`
  const { data: content, error } = await admin
    .from('moderation_content')
    .insert({ owner_id: ownerId, moderation_state: 'held', body })
    .select('id')
    .single()
  if (error) throw error
  const { data: openCase, error: caseError } = await admin
    .from('moderation_cases')
    .select('id')
    .eq('target_id', content.id)
    .in('state', ['open', 'claimed'])
    .single()
  if (caseError) throw caseError
  return { contentId: content.id as string, caseId: openCase.id as string, ownerId }
}

export async function login(page: Page, email: string): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').fill(email)
  await page.getByLabel('Password').fill(password())
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page).toHaveURL(/\/admin\/moderation/, { timeout: 20_000 })
}

export async function logout(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click()
  await expect(page).toHaveURL(/\/login/)
}

export const member = (n: number) => MEMBERS[n - 1]!.email

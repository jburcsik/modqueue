// Shared setup for the integration suites: a service-role client, ephemeral
// users made through the admin auth API, and cleanup that leaves the seed
// untouched. Every fixture is created in beforeAll and removed in afterAll.

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Notifier } from '../../src/store.js'
import type { Role } from '../../src/types.js'

export const SUPABASE_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54421'
export const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
export const ANON_KEY = process.env.SUPABASE_ANON_KEY ?? ''

const clientOptions = { auth: { persistSession: false, autoRefreshToken: false } }

export function serviceClient(url = SUPABASE_URL): SupabaseClient {
  if (!SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not set')
  return createClient(url, SERVICE_ROLE_KEY, clientOptions)
}

export interface TestUser {
  id: string
  email: string
  password: string
}

let counter = 0

/** A fresh auth user with an example.com address; `role` adds a moderation_roles row. */
export async function createUser(client: SupabaseClient, label: string, role: Role = 'member'): Promise<TestUser> {
  counter += 1
  const email = `${label}-${Date.now()}-${counter}@example.com`
  const password = `pw-${Math.random().toString(36).slice(2)}-${Date.now()}`
  const { data, error } = await client.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`)
  if (role !== 'member') {
    const { error: roleError } = await client
      .from('moderation_roles')
      .insert({ user_id: data.user.id, role, display_name: `Reviewer ${counter}` })
    if (roleError) throw new Error(`moderation_roles insert failed: ${roleError.message}`)
  }
  return { id: data.user.id, email, password }
}

/** A client signed in as `user` through the anon key, for RLS and client-callable checks. */
export async function userClient(user: TestUser): Promise<SupabaseClient> {
  const client = createClient(SUPABASE_URL, ANON_KEY, clientOptions)
  const { error } = await client.auth.signInWithPassword({ email: user.email, password: user.password })
  if (error) throw new Error(`sign in failed: ${error.message}`)
  return client
}

export async function insertContent(client: SupabaseClient, ownerId: string, body: string, state = 'visible'): Promise<string> {
  const { data, error } = await client
    .from('moderation_content')
    .insert({ owner_id: ownerId, body, moderation_state: state })
    .select('id')
    .single()
  if (error) throw new Error(`moderation_content insert failed: ${error.message}`)
  return (data as { id: string }).id
}

export async function contentState(client: SupabaseClient, contentId: string): Promise<string | null> {
  const { data } = await client.from('moderation_content').select('moderation_state').eq('id', contentId).maybeSingle()
  return (data as { moderation_state: string } | null)?.moderation_state ?? null
}

/** Tracks what a suite created so afterAll can remove it in dependency order. */
export class Fixtures {
  readonly users: TestUser[] = []
  readonly contentIds: string[] = []

  constructor(readonly client: SupabaseClient) {}

  async user(label: string, role: Role = 'member'): Promise<TestUser> {
    const user = await createUser(this.client, label, role)
    this.users.push(user)
    return user
  }

  async content(ownerId: string, body: string, state = 'visible'): Promise<string> {
    const id = await insertContent(this.client, ownerId, body, state)
    this.contentIds.push(id)
    return id
  }

  async cleanup(): Promise<void> {
    const userIds = this.users.map((u) => u.id)
    if (this.contentIds.length > 0) {
      await this.client.from('moderation_events').delete().in('target_id', this.contentIds)
      await this.client.from('moderation_reports').delete().in('target_id', this.contentIds)
      await this.client.from('moderation_cases').delete().in('target_id', this.contentIds)
      await this.client.from('moderation_content').delete().in('id', this.contentIds)
    }
    if (userIds.length > 0) {
      await this.client.from('moderation_events').delete().in('target_id', userIds)
      await this.client.from('moderation_events').delete().in('actor_id', userIds)
    }
    for (const id of userIds) await this.client.auth.admin.deleteUser(id)
  }
}

export interface RecordingNotifier extends Notifier {
  appeals: Array<Parameters<Notifier['onAppealResolved']>[0]>
}

export function recordingNotifier(): RecordingNotifier {
  const appeals: RecordingNotifier['appeals'] = []
  return {
    appeals,
    async onTierEscalated() {},
    async onAppealResolved(notice) {
      appeals.push(notice)
    },
    async onContentApproved() {},
  }
}

/** The ModerationError code thrown by `fn`, or null when it resolved. */
export async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn()
    return null
  } catch (error) {
    return (error as { code?: string }).code ?? `thrown: ${String(error)}`
  }
}

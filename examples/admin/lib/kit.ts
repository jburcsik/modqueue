// Shared kit wiring: the service-role store, the session authorizer, the
// no-op notifier and the queue read used by the pages and routes.

import type { Authorizer, Notifier, Principal, QueueFilter, QueueItem, Role } from 'modqueue'
import { createSupabaseAuthorizer, createSupabaseStore, loadQueue, type SupabaseStore } from 'modqueue/supabase'
import { serviceClient, sessionClient } from '@/lib/supabase/server'

function store(): SupabaseStore {
  return createSupabaseStore(serviceClient())
}

/** The host owns notifications; the example sends none. */
export const notifier: Notifier = {
  onTierEscalated: async () => {},
  onAppealResolved: async () => {},
  onContentApproved: async () => {},
}

async function authorizer(moderationStore: SupabaseStore): Promise<Authorizer> {
  return createSupabaseAuthorizer(await sessionClient(), moderationStore)
}

export async function requireRole(minRole: Role): Promise<{ principal: Principal; store: SupabaseStore }> {
  const moderationStore = store()
  const principal = await (await authorizer(moderationStore)).requireRole(minRole)
  return { principal, store: moderationStore }
}

export function readQueue(
  moderationStore: SupabaseStore,
  principal: Principal,
  filter: QueueFilter,
  ownerId: string | null,
): Promise<QueueItem[]> {
  return loadQueue(moderationStore, {
    filter,
    claimed: null,
    userId: ownerId,
    callerId: principal.userId,
    callerRole: principal.role,
  })
}

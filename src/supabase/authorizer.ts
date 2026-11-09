// Authorizer over a Supabase session.
//
// The session client carries the caller's sign-in; the role comes from
// `moderation_roles` through the service-role store, since members have no
// grant on that table. A user with no row is a member.

import type { SupabaseClient } from '@supabase/supabase-js'
import { roleAtLeast } from '../roles.js'
import type { Authorizer, ModerationStore } from '../store.js'
import { ModerationError, type Principal, type Role } from '../types.js'

export function createSupabaseAuthorizer(sessionClient: SupabaseClient, store: Pick<ModerationStore, 'listRoles'>): Authorizer {
  return {
    async requireRole(minRole: Role): Promise<Principal> {
      const { data, error } = await sessionClient.auth.getUser()
      const user = data?.user
      if (error || !user) throw new ModerationError('unauthenticated', error?.message)

      const [row] = await store.listRoles([user.id])
      const principal: Principal = { userId: user.id, role: row?.role ?? 'member', displayName: row?.displayName ?? null }
      if (!roleAtLeast(principal.role, minRole)) {
        throw new ModerationError('forbidden', `requires ${minRole}`)
      }
      return principal
    },
  }
}

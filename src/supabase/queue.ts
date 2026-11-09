// Queue loading with the identity rule.
//
// Admins read owner and reporter identity; moderators never do. A user filter
// is an identity pivot, so it is admin-only and leaves a `user_lookup` audit
// row, debounced so a repeated filter does not flood the log.

import { logUserLookup } from '../actions.js'
import { systemClock } from '../clock.js'
import { defaultConfig } from '../config.js'
import type { Clock, ModerationStore } from '../store.js'
import { ModerationError, type QueueFilter, type QueueItem, type Role } from '../types.js'

export interface LoadQueueInput {
  filter: QueueFilter
  /** `me`, `none`, a moderator id, or null for no claim filter. Applied after the read. */
  claimed: 'me' | 'none' | string | null
  /** Restrict to one content owner. Admin only. */
  userId: string | null
  callerId: string
  callerRole: Role
  limit?: number
}

export interface LoadQueueOptions {
  clock?: Clock
  /** Window within which a repeated lookup of the same user by the same caller is not logged again. */
  userLookupDebounceMs?: number
}

export const DEFAULT_QUEUE_LIMIT = 100

/** Strips owner and reporter identity from every item unless `includeIdentity`; member and system events lose their actor too. */
export function shapeQueueItems(items: QueueItem[], includeIdentity: boolean): QueueItem[] {
  if (includeIdentity) return items
  return items.map((item) => ({
    ...item,
    ownerId: null,
    ownerDisplayName: null,
    reports: item.reports.map((report) => ({ ...report, reporterId: null })),
    events: item.events.map((event) => (event.source === 'member' || event.source === 'system' ? { ...event, actorId: null } : event)),
  }))
}

export async function loadQueue(store: ModerationStore, input: LoadQueueInput, options: LoadQueueOptions = {}): Promise<QueueItem[]> {
  const includeIdentity = input.callerRole === 'admin'
  if (input.userId && !includeIdentity) {
    throw new ModerationError('forbidden', 'user filter is admin only')
  }

  if (input.userId) {
    await logUserLookup(
      store,
      input.callerId,
      input.userId,
      { userLookupDebounceMs: options.userLookupDebounceMs ?? defaultConfig.userLookupDebounceMs },
      options.clock ?? systemClock,
      { filter: input.filter },
    )
  }

  const items = await store.readQueue({
    filter: input.filter,
    callerId: input.callerId,
    ownerId: input.userId,
    includeIdentity,
    limit: input.limit ?? DEFAULT_QUEUE_LIMIT,
  })

  const claimed = input.claimed
  const filtered =
    claimed === 'me'
      ? items.filter((item) => item.claimedBy === input.callerId)
      : claimed === 'none'
        ? items.filter((item) => item.claimedBy === null)
        : claimed
          ? items.filter((item) => item.claimedBy === claimed)
          : items

  return shapeQueueItems(filtered, includeIdentity)
}

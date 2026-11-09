// Claim, release and take-over on moderation_cases.claimed_by.
//
// A claim marks who is working a case; it never blocks a decision. Taking
// over another moderator's claim is an admin action.

import type { ModerationStore } from '../store.js'
import { ModerationError, type CaseRow, type Role } from '../types.js'

export interface ClaimInput {
  caseId: string
  actorId: string
  actorRole: Role
}

/** Claims an unclaimed case or re-claims one's own. Throws `case_claimed_by_other` or `case_not_open`. */
export async function claimCase(store: ModerationStore, input: ClaimInput): Promise<CaseRow> {
  return store.claimCase(input.caseId, input.actorId, false)
}

/** Releases one's own claim; an admin releases anyone's. Throws `forbidden` or `case_not_open`. */
export async function releaseCase(store: ModerationStore, input: ClaimInput): Promise<CaseRow> {
  return store.releaseCase(input.caseId, input.actorId, input.actorRole === 'admin')
}

/** Moves a claim to the admin regardless of who holds it. Throws `forbidden` below admin, `case_not_open` when decided. */
export async function takeOverCase(store: ModerationStore, input: ClaimInput): Promise<CaseRow> {
  if (input.actorRole !== 'admin') throw new ModerationError('forbidden', 'take over is admin only')
  return store.claimCase(input.caseId, input.actorId, true)
}

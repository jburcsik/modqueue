// Appeals: file, list, resolve.
//
// Overturn revokes the strike and, when the strike came from a remove ruling,
// restores the content through `decide_moderation_case('restore')` so the
// audit row, the case and the content state move together.

import type { ModerationStore, Notifier } from '../store.js'
import {
  ModerationError,
  type ActorSource,
  type AppealResolution,
  type AppealRow,
  type DecideCaseResult,
  type Role,
} from '../types.js'

export async function fileAppeal(store: ModerationStore, userId: string, strikeId: string, statement: string): Promise<string> {
  return store.fileAppeal({ userId, strikeId, statement })
}

export async function listPendingAppeals(store: ModerationStore, limit = 100): Promise<AppealRow[]> {
  return store.listAppeals('pending', limit)
}

export interface ResolveAppealInput {
  appealId: string
  resolution: AppealResolution
  actorId: string
  actorRole: Role
  note: string | null
  /** Receives a notifier failure; the resolution stands either way. Defaults to console.error. */
  onError?: (context: string, error: unknown) => void
}

export interface ResolveAppealResult {
  appeal: AppealRow
  /** True when overturn revoked the strike; false when it was already revoked. */
  strikeRevoked: boolean
  /** The restore decision when the strike's event is a `content_remove` on a case; null otherwise. */
  decision: DecideCaseResult | null
  eventId: string | null
}

export async function resolveAppeal(store: ModerationStore, notifier: Notifier, input: ResolveAppealInput): Promise<ResolveAppealResult> {
  const onError = input.onError ?? ((context: string, error: unknown) => console.error(`[modqueue] ${context}`, error))
  const source: ActorSource = input.actorRole === 'admin' ? 'admin' : 'moderator'

  const appeal = await store.resolveAppeal(input.appealId, input.resolution, input.actorId, input.note)

  let strikeRevoked = false
  let decision: DecideCaseResult | null = null

  if (input.resolution === 'overturn') {
    const revoked = await store.revokeStrike(appeal.strikeId, input.actorId)
    strikeRevoked = revoked !== null
    if (revoked) {
      await store.insertEvent({
        targetType: 'user',
        targetId: appeal.userId,
        eventType: 'strike_revoked',
        source,
        severity: 'info',
        summary: 'Strike revoked on appeal',
        details: { appeal_id: appeal.id, strike_id: appeal.strikeId },
        actorId: input.actorId,
        caseId: null,
        priorState: null,
      })
    }

    const caseId = await caseIdForAppeal(store, appeal)
    if (caseId) {
      try {
        decision = await store.decideCase({
          caseId,
          decision: 'restore',
          flagJustified: null,
          actorId: input.actorId,
          source,
          reason: input.note ?? 'Restored on appeal',
        })
      } catch (error) {
        if (!(ModerationError.is(error) && error.code === 'case_not_open')) throw error
        onError('resolveAppeal.restore', error)
      }
    }
  }

  const eventId = await store.insertEvent({
    targetType: 'user',
    targetId: appeal.userId,
    eventType: 'appeal_resolved',
    source,
    severity: 'info',
    summary: input.resolution === 'uphold' ? 'Appeal upheld' : 'Appeal overturned',
    details: {
      appeal_id: appeal.id,
      strike_id: appeal.strikeId,
      resolution: input.resolution,
      strike_revoked: strikeRevoked,
      case_id: decision?.caseId ?? null,
      reviewer_note: input.note,
    },
    actorId: input.actorId,
    caseId: decision?.caseId ?? null,
    priorState: null,
  })

  try {
    await notifier.onAppealResolved({
      userId: appeal.userId,
      appealId: appeal.id,
      resolution: input.resolution,
      messageKey: input.resolution === 'uphold' ? 'appeal_upheld' : 'appeal_overturned',
    })
  } catch (error) {
    onError('notifier.onAppealResolved', error)
  }

  return { appeal, strikeRevoked, decision, eventId }
}

/** The case behind a remove ruling, read from the event the appeal copied at filing time; null for any other event. */
async function caseIdForAppeal(store: ModerationStore, appeal: AppealRow): Promise<string | null> {
  let eventId = appeal.moderationEventId
  if (!eventId) {
    const strike = await store.getStrike(appeal.strikeId)
    eventId = strike?.moderationEventId ?? null
  }
  if (!eventId) return null
  const event = await store.getEvent(eventId)
  return event?.eventType === 'content_remove' ? event.caseId : null
}

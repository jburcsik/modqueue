import type { ModerationConfig } from './config.js'
import { getStrikeConsequence, strikeExpiresAt, strikeWeight, tierIndex } from './ladder.js'
import { computeReach, getNotificationPolicy } from './reach.js'
import type { Clock, ModerationStore, Notifier } from './store.js'
import { systemClock } from './clock.js'
import {
  ModerationError,
  type ActionActor,
  type ActorSource,
  type CaseDecision,
  type ContentState,
  type EventType,
  type ModerationActionInput,
  type ModerationActionResult,
  type ModerationOp,
  type Severity,
  type StrikeConsequence,
} from './types.js'

const SEVERITY_LABEL: Record<Severity, string> = { info: 'Minor', warning: 'Warning', violation: 'Violation', severe: 'Severe' }

const OP_VERB: Record<ModerationOp, string> = {
  approve: 'approved',
  hold: 'held',
  warn: 'warned',
  remove: 'removed',
  dismiss: 'dismissed the reports on',
  note: 'left a note on',
}

const ROLE_LABEL: Record<Exclude<ActionActor, 'automated'>, string> = {
  admin: 'An admin',
  moderator: 'A moderator',
  system: 'The system',
}

/** Case decision for the ops that settle a case; null for the ops the spine writes itself. */
const OP_DECISION: Record<ModerationOp, { decision: CaseDecision; flagJustified: boolean | null } | null> = {
  approve: { decision: 'keep', flagJustified: null },
  dismiss: { decision: 'keep', flagJustified: false },
  remove: { decision: 'remove', flagJustified: true },
  hold: null,
  warn: null,
  note: null,
}

const OP_EVENT: Record<Exclude<ModerationOp, 'approve' | 'dismiss' | 'remove'>, EventType> = {
  hold: 'content_hold',
  warn: 'content_warn',
  note: 'mod_note',
}

const USER_TARGET_OPS: ReadonlyArray<ModerationOp> = ['warn', 'note']

export function severityForOp(op: ModerationOp): Severity {
  if (op === 'remove') return 'violation'
  if (op === 'warn' || op === 'hold') return 'warning'
  return 'info'
}

/** Reviewer-facing audit sentence. May name the actor; never shown to members. */
export function buildActionSummary(input: ModerationActionInput, config: ModerationConfig): string {
  const who =
    input.actor === 'automated'
      ? config.automation.automatedActorLabel
      : input.actorName?.trim() || ROLE_LABEL[input.actor]

  let summary = `${who} ${OP_VERB[input.op]} this ${input.targetType}`

  if (input.strike) {
    const { points } = strikeWeight(input.strike.severity, config.strikes)
    summary += ` and added a ${SEVERITY_LABEL[input.strike.severity]} strike (${points} ${points === 1 ? 'point' : 'points'})`
  }

  const reason = (input.op === 'note' ? input.reason : input.strike?.reason || input.reason)?.trim()
  if (reason) summary += `: "${reason}"`
  return summary
}

export interface AddStrikeInput {
  userId: string
  severity: Severity
  reason: string
  source: ActorSource
  actorId: string | null
  moderationEventId: string | null
  caseId: string | null
}

export interface AddStrikeResult {
  strikeId: string | null
  consequenceBefore: StrikeConsequence
  consequenceAfter: StrikeConsequence
  /** True when the notifier was told about an upward tier change. */
  notified: boolean
}

/**
 * Inserts a strike weighted by severity, writes `strike_added`, and notifies
 * the host only when the member entered a higher notified tier.
 */
export async function addStrike(
  store: ModerationStore,
  notifier: Notifier,
  input: AddStrikeInput,
  config: ModerationConfig,
  clock: Clock = systemClock,
  issueType: ModerationActionInput['issueType'] = null,
): Promise<AddStrikeResult> {
  const ladder = config.strikes.ladder
  const consequenceBefore = getStrikeConsequence(await store.activeStrikePoints(input.userId), ladder)
  const { points } = strikeWeight(input.severity, config.strikes)
  const expiresAt = strikeExpiresAt(input.severity, config.strikes, clock.now())

  const strikeId = await store.insertStrike({
    userId: input.userId,
    severity: input.severity,
    points,
    reason: input.reason,
    expiresAt,
    moderationEventId: input.moderationEventId,
  })

  const eventId = await store.insertEvent({
    targetType: 'user',
    targetId: input.userId,
    eventType: 'strike_added',
    source: input.source,
    severity: input.severity,
    summary: null,
    details: { strike_id: strikeId, severity: input.severity, points, expires_at: expiresAt, reason: input.reason, moderation_event_id: input.moderationEventId },
    actorId: input.actorId,
    caseId: input.caseId,
    priorState: null,
  })

  const consequenceAfter = getStrikeConsequence(await store.activeStrikePoints(input.userId), ladder)
  const escalated = consequenceAfter.notify && tierIndex(consequenceAfter.tier) > tierIndex(consequenceBefore.tier)
  if (escalated && consequenceAfter.messageKey) {
    await notifier.onTierEscalated({
      userId: input.userId,
      tier: consequenceAfter.tier,
      messageKey: consequenceAfter.messageKey,
      issueType,
      strikeId,
      eventId: input.moderationEventId ?? eventId,
    })
  }

  return { strikeId, consequenceBefore, consequenceAfter, notified: escalated }
}

/** Revokes a strike and writes `strike_revoked`; null when the strike is missing or already revoked. */
export async function revokeStrike(
  store: ModerationStore,
  strikeId: string,
  revokedBy: string | null,
  source: ActorSource,
  reason: string | null,
): Promise<string | null> {
  const row = await store.revokeStrike(strikeId, revokedBy)
  if (!row) return null
  return store.insertEvent({
    targetType: 'user',
    targetId: row.userId,
    eventType: 'strike_revoked',
    source,
    severity: 'info',
    summary: reason,
    details: { strike_id: row.id, points: row.points, reason },
    actorId: revokedBy,
    caseId: null,
    priorState: null,
  })
}

const APPROVING_OPS: ReadonlyArray<ModerationOp> = ['approve', 'dismiss']
const APPROVING_AUTOMATED = ['allow', 'allow_log', 'auto_allow']

/**
 * When a human settles content the automated reviewer judged differently,
 * one `mod_note` records the override against the automated event.
 */
async function recordOverride(store: ModerationStore, input: ModerationActionInput, caseId: string | null): Promise<void> {
  if (input.actor === 'automated' || input.actor === 'system' || input.targetType !== 'content' || input.op === 'note') return
  const automated = (await store.listEvents('content', input.targetId, 50)).find((event) => event.source === 'automated')
  if (!automated) return
  const details = automated.details
  const automatedAction = typeof details['would_have'] === 'string' ? details['would_have'] : details['action']
  if (typeof automatedAction !== 'string') return
  if (APPROVING_OPS.includes(input.op) === APPROVING_AUTOMATED.includes(automatedAction)) return
  await store.insertEvent({
    targetType: 'content',
    targetId: input.targetId,
    eventType: 'mod_note',
    source: input.actor,
    severity: 'info',
    summary: `Human decision overrode the automated verdict (${automatedAction})`,
    details: { action: 'override', overrides_event_id: automated.id, automated_action: automatedAction, human_action: input.op },
    actorId: input.actorId,
    caseId,
    priorState: null,
  })
}

/**
 * One way to perform a moderation operation, for any actor. `approve`,
 * `dismiss` and `remove` settle the case (opening one when none exists)
 * through `decideCase`, which writes the audit row; `hold`, `warn` and `note`
 * write their own. A strike, when given, lands on `ownerId` and notifies the
 * host only when the member moved up into a notified tier.
 */
export async function applyModerationAction(
  store: ModerationStore,
  notifier: Notifier,
  input: ModerationActionInput,
  config: ModerationConfig,
  clock: Clock = systemClock,
): Promise<ModerationActionResult> {
  const { targetType, targetId, op } = input
  if (targetType === 'user' && !USER_TARGET_OPS.includes(op)) {
    throw new ModerationError('invalid_input', `op ${op} needs a content target`)
  }
  const strikeUserId = targetType === 'user' ? targetId : input.ownerId
  if (input.strike && !strikeUserId) throw new ModerationError('invalid_input', 'ownerId is required to add a strike')

  if (input.caseId && targetType === 'content') {
    const existing = await store.getCase(input.caseId)
    if (!existing || existing.targetId !== targetId) throw new ModerationError('invalid_input', 'case does not belong to the target')
  }

  const summary = buildActionSummary(input, config)
  const settle = OP_DECISION[op]
  let eventId: string | null = null
  let decision: ModerationActionResult['decision'] = null
  let caseId = input.caseId

  if (settle && targetType === 'content') {
    caseId = caseId ?? (await store.openCaseFor(targetId))?.id ?? (await store.openCase(targetId)).id
    decision = await store.decideCase({
      caseId,
      decision: settle.decision,
      flagJustified: settle.flagJustified,
      actorId: input.actorId,
      source: input.actor,
      reason: summary,
    })
    eventId = decision.eventId
  } else {
    let priorState: ContentState | null = null
    if (op === 'hold' && targetType === 'content') {
      priorState = await store.setContentState(targetId, 'held')
      if (priorState === null) throw new ModerationError('not_found', `content ${targetId}`)
      caseId = caseId ?? (await store.openCaseFor(targetId))?.id ?? null
    }
    eventId = await store.insertEvent({
      targetType,
      targetId,
      eventType: OP_EVENT[op as keyof typeof OP_EVENT],
      source: input.actor,
      severity: severityForOp(op),
      summary,
      details: { action: op, actor: input.actor, reason: input.reason, confidence: input.confidence, issue_type: input.issueType },
      actorId: input.actorId,
      caseId,
      priorState,
    })
  }

  await recordOverride(store, input, caseId)

  if (op === 'approve' && targetType === 'content' && input.ownerId) {
    const reach = computeReach(
      { reputation: await store.reputationInputs(input.ownerId), activeStrikePoints: await store.activeStrikePoints(input.ownerId), nowMs: clock.now() },
      config,
    )
    await notifier.onContentApproved({ contentId: targetId, ownerId: input.ownerId, policy: getNotificationPolicy(reach.coefficient, config.reach.notification) })
  }

  if (!input.strike || !strikeUserId) {
    return { eventId, strikeId: null, decision, consequenceBefore: null, consequenceAfter: null }
  }

  const strike = await addStrike(
    store,
    notifier,
    { userId: strikeUserId, severity: input.strike.severity, reason: input.strike.reason, source: input.actor, actorId: input.actorId, moderationEventId: eventId, caseId },
    config,
    clock,
    input.issueType,
  )
  return { eventId, strikeId: strike.strikeId, decision, consequenceBefore: strike.consequenceBefore, consequenceAfter: strike.consequenceAfter }
}

/**
 * Writes a `user_lookup` audit event unless the same actor looked the user up
 * within the debounce window. Looking up a member is an admin action, so the
 * source is `admin`.
 */
export async function logUserLookup(
  store: ModerationStore,
  actorId: string,
  targetUserId: string,
  config: Pick<ModerationConfig, 'userLookupDebounceMs'>,
  clock: Clock = systemClock,
  details: Record<string, unknown> = {},
): Promise<string | null> {
  const since = new Date(clock.now() - config.userLookupDebounceMs).toISOString()
  if (await store.recentUserLookup(actorId, targetUserId, since)) return null
  return store.insertEvent({
    targetType: 'user',
    targetId: targetUserId,
    eventType: 'user_lookup',
    source: 'admin',
    severity: 'info',
    summary: null,
    details,
    actorId,
    caseId: null,
    priorState: null,
  })
}

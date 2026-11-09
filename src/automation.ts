import { applyModerationAction } from './actions.js'
import type { ModerationConfig } from './config.js'
import { systemClock } from './clock.js'
import type { Clock, ModerationStore, Notifier } from './store.js'
import type { AutomatedActionResult, DecisionTier, EventType, ModerationDecision, ModerationEventInput, Settings, Severity } from './types.js'

export interface AutomatedActionInput {
  contentId: string
  ownerId: string
  decision: ModerationDecision
  settings: Settings
  /** `ModerationProvider.name`; recorded in event details. */
  providerName: string
}

function wouldHave(tier: DecisionTier): string {
  if (tier === 'hold') return 'remove_or_hold'
  return tier
}

const NOT_ACTED: AutomatedActionResult = { acted: false, op: null, logged: null, eventId: null }

/**
 * Runs the automation matrix after a submission is stored.
 *
 * | level     | behaviour |
 * |-----------|-----------|
 * | off       | nothing, not even a log |
 * | assist    | `ai_flag` shadow log of what would have happened |
 * | semi_auto | hold at or above `autoActionConfidence`; `auto_allow` log for allow tiers; shadow log otherwise |
 * | full_auto | severe escalates to humans; hold removes with a strike at or above the remove floor, else holds; warn warns with a strike at confidence; allow logs |
 *
 * `full_auto` without `fullAutoAcknowledgedAt` writes an `escalated` event
 * and runs as `semi_auto`.
 */
export async function runAutomatedAction(
  store: ModerationStore,
  notifier: Notifier,
  input: AutomatedActionInput,
  config: ModerationConfig,
  clock: Clock = systemClock,
): Promise<AutomatedActionResult> {
  const { settings, decision, contentId, ownerId } = input
  let level = settings.automationLevel
  if (level === 'off') return NOT_ACTED

  const details = {
    provider: input.providerName,
    tier: decision.tier,
    severity: decision.severity,
    confidence: decision.confidence,
    flagged_categories: decision.flaggedCategories,
    scores: decision.scores,
    provider_unavailable: decision.providerUnavailable,
  }

  async function log(eventType: EventType, severity: Severity, extra: Record<string, unknown>): Promise<AutomatedActionResult> {
    const event: ModerationEventInput = {
      targetType: 'content',
      targetId: contentId,
      eventType,
      source: 'automated',
      severity,
      summary: null,
      details: { ...details, ...extra },
      actorId: null,
      caseId: null,
      priorState: null,
    }
    return { acted: false, op: null, logged: eventType, eventId: await store.insertEvent(event) }
  }

  const shadow = () => log('ai_flag', decision.severity ?? 'info', { action: 'shadow_only', would_have: wouldHave(decision.tier) })
  const autoAllow = () => log('auto_allow', 'info', { action: 'auto_allow' })

  async function act(op: 'hold' | 'warn' | 'remove', strike: { severity: Severity; reason: string } | null, fallbackReason: string): Promise<AutomatedActionResult> {
    const result = await applyModerationAction(
      store,
      notifier,
      {
        targetType: 'content',
        targetId: contentId,
        op,
        actor: 'automated',
        actorId: null,
        actorName: null,
        reason: decision.reason ?? fallbackReason,
        confidence: decision.confidence,
        strike,
        ownerId,
        issueType: null,
        caseId: null,
      },
      config,
      clock,
    )
    return { acted: true, op, logged: null, eventId: result.eventId }
  }

  if (level === 'assist') return shadow()

  if (level === 'full_auto' && !settings.fullAutoAcknowledgedAt) {
    await log('escalated', 'info', { action: 'escalated', reason: 'full_auto_not_acknowledged' })
    level = 'semi_auto'
  }

  const isAllow = decision.tier === 'allow' || decision.tier === 'allow_log'

  if (level === 'semi_auto') {
    if (decision.tier === 'hold' && decision.confidence >= settings.autoActionConfidence) {
      return act('hold', null, 'Held by automated review')
    }
    return isAllow ? autoAllow() : shadow()
  }

  if (decision.severity === 'severe') {
    return log('escalated', 'severe', { action: 'escalated', reason: 'severe_content' })
  }
  if (decision.tier === 'hold') {
    const removeFloor = Math.max(settings.autoActionConfidence, config.automation.fullAutoRemoveFloor)
    if (decision.confidence >= removeFloor) {
      return act('remove', { severity: 'violation', reason: decision.reason ?? 'Removed by automated review' }, 'Removed by automated review')
    }
    return act('hold', null, 'Held by automated review')
  }
  if (decision.tier === 'warn' && decision.confidence >= settings.autoActionConfidence) {
    return act('warn', { severity: 'warning', reason: decision.reason ?? 'Warning from automated review' }, 'Warning from automated review')
  }
  return isAllow ? autoAllow() : shadow()
}

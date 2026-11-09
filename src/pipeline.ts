import { runAutomatedAction } from './automation.js'
import { filterContent } from './filter/content-filter.js'
import { getStrikeConsequence } from './ladder.js'
import { applyReachToTtl, computeReach, neutralReputationInputs } from './reach.js'
import { createRateLimiter } from './rate-limit.js'
import { scoreContent } from './scoring.js'
import type { PipelineDeps } from './store.js'
import { resolveTrust } from './trust.js'
import type {
  AutomatedActionResult,
  ModerationErrorCode,
  PendingEvent,
  ScreenSubmissionInput,
  ScreenSubmissionResult,
  StrikeConsequence,
} from './types.js'

/**
 * Everything that happens before a submission is stored, in order: trust,
 * the daily cap, the strike gate, the local filter, provider scoring, reach,
 * lifetime and initial state. Moderators and admins skip the gates. Returns
 * the events to write once the content row exists.
 */
export async function screenSubmission(input: ScreenSubmissionInput, deps: PipelineDeps): Promise<ScreenSubmissionResult> {
  const { store, provider, clock, config } = deps
  const now = clock.now()
  const privileged = input.role !== 'member'
  const settings = await store.loadSettings()
  const trust = resolveTrust(input.accountCreatedAt, input.reputationInputs, config, now)
  const activeStrikePoints = await store.activeStrikePoints(input.userId)
  const consequence: StrikeConsequence = privileged
    ? { ...getStrikeConsequence(0, config.strikes.ladder), points: activeStrikePoints }
    : getStrikeConsequence(activeStrikePoints, config.strikes.ladder)
  const filter = filterContent(input.text, config)
  const reach = computeReach(
    {
      reputation: input.reputationInputs ?? neutralReputationInputs(input.userId, input.accountCreatedAt),
      activeStrikePoints,
      nowMs: now,
    },
    config,
  )
  const ttlHours = input.baseTtlHours === null ? null : applyReachToTtl(input.baseTtlHours, reach.coefficient, config.reach.ttl)

  const reject = (rejection: ModerationErrorCode): ScreenSubmissionResult => ({
    allowed: false,
    rejection,
    userId: input.userId,
    clean: filter.clean,
    filter,
    trust,
    decision: null,
    consequence,
    reach,
    ttlHours,
    initialState: 'held',
    events: [],
  })

  if (!privileged) {
    const limiter = createRateLimiter(store, config.rateLimits)
    if (!(await limiter.daily(input.userId, trust.submissionsPerDay))) return reject('rate_limited')
    if (!consequence.canPost) return reject('posting_paused')
  }
  if (filter.blocked) return reject('content_blocked')

  const decision = await scoreContent(filter.clean, settings, provider, config)
  const events: PendingEvent[] = []

  if (!privileged && consequence.requiresApproval) {
    events.push({
      eventType: 'tier_hold',
      source: 'system',
      severity: 'info',
      summary: 'Held for review while the member is on the review-gated tier',
      details: { release_below_points: config.strikes.ladder.reviewGated, active_points: activeStrikePoints, tier: consequence.tier },
      actorId: null,
      caseId: null,
      priorState: null,
    })
  } else if (!privileged && trust.requiresApproval) {
    events.push({
      eventType: 'content_hold',
      source: 'system',
      severity: 'info',
      summary: 'Held for review because the account is new',
      details: { action: 'hold', actor: 'system', reason: 'trust_approval', trust_level: trust.level },
      actorId: null,
      caseId: null,
      priorState: null,
    })
  }

  if (filter.tripwire.hit) {
    events.push({
      eventType: 'tripwire',
      source: 'system',
      severity: 'warning',
      summary: null,
      details: { patterns: filter.tripwire.patterns, stripped_count: filter.normalizer.strippedCount },
      actorId: null,
      caseId: null,
      priorState: null,
    })
  }

  const held = decision.tier === 'hold' || (!privileged && (trust.requiresApproval || consequence.requiresApproval))

  return {
    allowed: true,
    rejection: null,
    userId: input.userId,
    clean: filter.clean,
    filter,
    trust,
    decision,
    consequence,
    reach,
    ttlHours,
    initialState: held ? 'held' : 'visible',
    events,
  }
}

export interface RecordSubmissionResult {
  eventIds: Array<string | null>
  /** Null when the submission was not allowed or carried no decision. */
  automation: AutomatedActionResult | null
}

const HOLD_EVENTS: ReadonlyArray<PendingEvent['eventType']> = ['tier_hold', 'content_hold']

/**
 * Writes the pending events against the stored content row, then runs the
 * automation matrix on the decision. Hold events carry the case the held
 * insert opened, which is what the strike sweep reads.
 */
export async function recordSubmission(
  contentId: string,
  result: ScreenSubmissionResult,
  deps: PipelineDeps,
): Promise<RecordSubmissionResult> {
  const { store, notifier, provider, config, clock } = deps
  const eventIds: Array<string | null> = []
  const holdCaseId = result.events.some((e) => HOLD_EVENTS.includes(e.eventType)) ? ((await store.openCaseFor(contentId))?.id ?? null) : null
  for (const event of result.events) {
    const caseId = event.caseId ?? (HOLD_EVENTS.includes(event.eventType) ? holdCaseId : null)
    eventIds.push(await store.insertEvent({ ...event, caseId, targetType: 'content', targetId: contentId }))
  }
  if (!result.allowed || !result.decision) return { eventIds, automation: null }
  const settings = await store.loadSettings()
  const automation = await runAutomatedAction(
    store,
    notifier,
    { contentId, ownerId: result.userId, decision: result.decision, settings, providerName: provider.name },
    config,
    clock,
  )
  return { eventIds, automation }
}

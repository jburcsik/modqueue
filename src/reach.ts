import type { ModerationConfig, ReachConfig, StepTable } from './config.js'
import type { NotificationPolicy, ReachFactors, ReachInputs, ReachResult, ReputationInputs } from './types.js'
import { accountAgeHours, calculateReputationScore } from './trust.js'

/** First row whose `below` exceeds the input, else `otherwise`. */
export function lookupStep(table: StepTable, input: number): number {
  for (const step of table.steps) {
    if (input < step.below) return step.value
  }
  return table.otherwise
}

/** The inputs of a user with no activity; used when the host has no reputation view. */
export function neutralReputationInputs(userId: string, accountCreatedAt: string): ReputationInputs {
  return {
    user_id: userId,
    account_created_at: accountCreatedAt,
    posts: 0,
    endorsed_posts: 0,
    endorsements_given: 0,
    reports_received: 0,
    far_rate: null,
  }
}

const NEUTRAL_FACTORS: ReachFactors = { age: 1, reputation: 1, strikes: 1, engagement: 1, farReport: 1 }

function engagementFactor(inputs: ReputationInputs, config: ReachConfig['engagement']): number {
  if (inputs.reports_received === 0) {
    return inputs.endorsed_posts >= config.bonusMinEndorsedPosts ? config.bonusFactor : 1
  }
  return inputs.endorsed_posts / inputs.reports_received > config.neutralRatio ? 1 : config.penaltyFactor
}

/**
 * The reach coefficient and its breakdown. Mirrors the SQL function
 * `calculate_reach_coefficient`; the parity test compares the two to four
 * decimals. With `reach.enabled` false the coefficient is 1.0 and every
 * factor 1.0. With no reputation row the coefficient is
 * `reach.unknownUserCoefficient` and the factors are 1.0.
 */
export function computeReach(inputs: ReachInputs, config: Pick<ModerationConfig, 'reach' | 'reputation'>): ReachResult {
  const { reach, reputation: reputationConfig } = config
  const rep = inputs.reputation
  const ageHours = rep ? accountAgeHours(rep.account_created_at, inputs.nowMs) : 0
  const score = rep ? calculateReputationScore(rep, reputationConfig) : reputationConfig.baseline
  const base = {
    enabled: reach.enabled,
    error: false,
    inputs: {
      accountAgeHours: ageHours,
      reputationScore: score,
      activeStrikePoints: inputs.activeStrikePoints,
      posts: rep?.posts ?? 0,
      endorsedPosts: rep?.endorsed_posts ?? 0,
      endorsementsGiven: rep?.endorsements_given ?? 0,
      reportsReceived: rep?.reports_received ?? 0,
      farRate: rep?.far_rate ?? null,
    },
  }

  if (!reach.enabled) return { ...base, coefficient: 1, factors: { ...NEUTRAL_FACTORS } }
  if (!rep) return { ...base, coefficient: reach.unknownUserCoefficient, factors: { ...NEUTRAL_FACTORS } }

  const factors: ReachFactors = {
    age: lookupStep(reach.age, ageHours),
    reputation: lookupStep(reach.reputation, score),
    strikes: lookupStep(reach.strikes, inputs.activeStrikePoints),
    engagement: engagementFactor(rep, reach.engagement),
    farReport: rep.far_rate === null ? 1 : lookupStep(reach.farReport, rep.far_rate),
  }
  const product = factors.age * factors.reputation * factors.strikes * factors.engagement * factors.farReport
  const coefficient = Math.max(reach.clamp.min, Math.min(reach.clamp.max, product))
  return { ...base, coefficient, factors }
}

/** Base lifetime scaled by reach, bounded by the floor and ceiling multipliers. */
export function applyReachToTtl(baseTtlHours: number, coefficient: number, ttl: ReachConfig['ttl']): number {
  const floor = baseTtlHours * ttl.floorMultiplier
  const ceiling = baseTtlHours * ttl.ceilingMultiplier
  return Math.max(floor, Math.min(ceiling, baseTtlHours * coefficient))
}

/** Fan-out policy for a coefficient; above the last step the radius is the coefficient capped. */
export function getNotificationPolicy(coefficient: number, config: ReachConfig['notification']): NotificationPolicy {
  for (const step of config.steps) {
    if (coefficient < step.below) return { shouldNotify: step.shouldNotify, radiusMultiplier: step.radiusMultiplier }
  }
  return { shouldNotify: true, radiusMultiplier: Math.min(coefficient, config.radiusCap) }
}

export const REACH_TIERS = ['hidden', 'low', 'reduced', 'normal', 'high'] as const
export type ReachTier = (typeof REACH_TIERS)[number]

/**
 * A label for admin screens. Below the visibility floor is `hidden`; the rest
 * follows the notification radius: above 1 is `high`, exactly 1 is `normal`,
 * at least half is `reduced`, less is `low`.
 */
export function reachTier(coefficient: number, config: ReachConfig): ReachTier {
  if (coefficient < config.visibilityFloor) return 'hidden'
  const { shouldNotify, radiusMultiplier } = getNotificationPolicy(coefficient, config.notification)
  if (!shouldNotify) return 'hidden'
  if (radiusMultiplier > 1) return 'high'
  if (radiusMultiplier === 1) return 'normal'
  if (radiusMultiplier >= 0.5) return 'reduced'
  return 'low'
}

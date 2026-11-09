import type { ModerationConfig, ReputationConfig, TrustConfig, TrustTier } from './config.js'
import type { ReputationInputs, TrustInfo } from './types.js'

const HOUR_MS = 60 * 60 * 1000

export function accountAgeHours(accountCreatedAt: string, nowMs: number): number {
  return Math.max(0, (nowMs - Date.parse(accountCreatedAt)) / HOUR_MS)
}

/** The tier whose upper bound the age is strictly below; the null-bounded tier otherwise. */
export function trustTierFor(ageHours: number, config: TrustConfig): TrustTier {
  const tier = config.tiers.find((t) => t.maxAgeHours === null || ageHours < t.maxAgeHours)
  if (!tier) throw new Error('trust.tiers must end with a tier whose maxAgeHours is null')
  return tier
}

export function getTrustLevel(accountCreatedAt: string, config: TrustConfig, nowMs: number): TrustInfo {
  const hours = accountAgeHours(accountCreatedAt, nowMs)
  const tier = trustTierFor(hours, config)
  return {
    level: tier.level,
    accountAgeHours: hours,
    canReport: tier.canReport,
    submissionsPerDay: tier.submissionsPerDay,
    requiresApproval: tier.requiresApproval,
  }
}

/** Integer score in `[config.min, config.max]`. The SQL function `get_user_reputation` computes the same number. */
export function calculateReputationScore(inputs: ReputationInputs, config: ReputationConfig): number {
  const score =
    config.baseline +
    Math.min(inputs.endorsed_posts * config.endorsedPostWeight, config.endorsedPostCap) +
    Math.min(inputs.endorsements_given * config.endorsementGivenWeight, config.endorsementGivenCap) +
    Math.min(inputs.posts * config.postWeight, config.postCap) -
    Math.min(inputs.reports_received * config.reportReceivedWeight, config.reportReceivedCap)
  return Math.max(config.min, Math.min(config.max, Math.round(score)))
}

/** Boost or restrict the daily cap and approval rule by reputation. The first tier keeps its approval rule when boosted. */
export function adjustTrustForReputation(trust: TrustInfo, score: number, config: TrustConfig): TrustInfo {
  const firstLevel = config.tiers[0]?.level
  if (score >= config.boostAt) {
    return {
      ...trust,
      submissionsPerDay: Math.min(trust.submissionsPerDay * config.boostMultiplier, config.boostCap),
      requiresApproval: trust.level === firstLevel ? trust.requiresApproval : false,
    }
  }
  if (score <= config.restrictAt) {
    return {
      ...trust,
      submissionsPerDay: Math.max(Math.floor(trust.submissionsPerDay / config.restrictDivisor), config.restrictFloor),
      requiresApproval: true,
    }
  }
  return trust
}

/** Trust by account age, adjusted by reputation when the host supplies inputs. */
export function resolveTrust(
  accountCreatedAt: string,
  reputation: ReputationInputs | null,
  config: Pick<ModerationConfig, 'trust' | 'reputation'>,
  nowMs: number,
): TrustInfo {
  const trust = getTrustLevel(accountCreatedAt, config.trust, nowMs)
  if (!reputation) return trust
  return adjustTrustForReputation(trust, calculateReputationScore(reputation, config.reputation), config.trust)
}

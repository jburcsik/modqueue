import type { LadderConfig, StrikesConfig } from './config.js'
import { STRIKE_TIERS, type Severity, type StrikeConsequence, type StrikeTier, type StrikeWeight } from './types.js'

const DAY_MS = 24 * 60 * 60 * 1000

export function strikeWeight(severity: Severity, config: StrikesConfig): StrikeWeight {
  return config.weights[severity]
}

/** ISO expiry for a strike added now, or null when the severity never expires. */
export function strikeExpiresAt(severity: Severity, config: StrikesConfig, nowMs: number): string | null {
  const { decayDays } = strikeWeight(severity, config)
  return decayDays === null ? null : new Date(nowMs + decayDays * DAY_MS).toISOString()
}

/** The posting consequence for a number of active strike points. */
export function getStrikeConsequence(activePoints: number, ladder: LadderConfig): StrikeConsequence {
  if (activePoints >= ladder.quieted) {
    return { tier: 'quieted', points: activePoints, notify: true, messageKey: 'quieted', canPost: false, requiresApproval: false }
  }
  if (activePoints >= ladder.reviewGated) {
    return { tier: 'review_gated', points: activePoints, notify: true, messageKey: 'review_gated', canPost: true, requiresApproval: true }
  }
  if (activePoints >= ladder.warned) {
    return { tier: 'warned', points: activePoints, notify: true, messageKey: 'warning', canPost: true, requiresApproval: false }
  }
  if (activePoints >= ladder.nudge) {
    return { tier: 'nudge', points: activePoints, notify: false, messageKey: null, canPost: true, requiresApproval: false }
  }
  return { tier: 'clean', points: activePoints, notify: false, messageKey: null, canPost: true, requiresApproval: false }
}

/** Position on the ladder; a higher index is a harsher tier. */
export function tierIndex(tier: StrikeTier): number {
  return STRIKE_TIERS.indexOf(tier)
}

/** Host notification kinds for the tiers that notify. */
export const TIER_NOTIFICATION_KIND: Partial<Record<StrikeTier, string>> = {
  warned: 'moderation_warning',
  review_gated: 'moderation_restriction',
  quieted: 'moderation_quieted',
}

export function tierNotificationKind(tier: StrikeTier): string | null {
  return TIER_NOTIFICATION_KIND[tier] ?? null
}

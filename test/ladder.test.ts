import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/config.js'
import { getStrikeConsequence, strikeExpiresAt, strikeWeight, tierIndex, tierNotificationKind } from '../src/ladder.js'
import { SEVERITIES } from '../src/types.js'
import { DAY_MS, NOW_MS } from './helpers.js'

const strikes = defaultConfig.strikes
const ladder = strikes.ladder

describe('strikeWeight and strikeExpiresAt', () => {
  it.each(SEVERITIES)('%s takes its points and decay from config', (severity) => {
    expect(strikeWeight(severity, strikes)).toEqual(strikes.weights[severity])
  })

  it('expires decaying strikes after their window and never expires permanent ones', () => {
    expect(strikeExpiresAt('warning', strikes, NOW_MS)).toBe(new Date(NOW_MS + 60 * DAY_MS).toISOString())
    expect(strikeExpiresAt('severe', strikes, NOW_MS)).toBeNull()
  })
})

describe('getStrikeConsequence', () => {
  it('maps points to tiers at the configured cut-offs', () => {
    expect(getStrikeConsequence(0, ladder).tier).toBe('clean')
    expect(getStrikeConsequence(ladder.nudge - 1, ladder).tier).toBe('clean')
    expect(getStrikeConsequence(ladder.nudge, ladder).tier).toBe('nudge')
    expect(getStrikeConsequence(ladder.warned - 1, ladder).tier).toBe('nudge')
    expect(getStrikeConsequence(ladder.warned, ladder).tier).toBe('warned')
    expect(getStrikeConsequence(ladder.reviewGated, ladder).tier).toBe('review_gated')
    expect(getStrikeConsequence(ladder.quieted - 1, ladder).tier).toBe('review_gated')
    expect(getStrikeConsequence(ladder.quieted, ladder).tier).toBe('quieted')
    expect(getStrikeConsequence(ladder.quieted + 10, ladder).tier).toBe('quieted')
  })

  it('notifies only from warned up and keeps the posting rules per tier', () => {
    expect(getStrikeConsequence(0, ladder)).toMatchObject({ notify: false, messageKey: null, canPost: true, requiresApproval: false })
    expect(getStrikeConsequence(ladder.nudge, ladder)).toMatchObject({ notify: false, messageKey: null, canPost: true, requiresApproval: false })
    expect(getStrikeConsequence(ladder.warned, ladder)).toMatchObject({ notify: true, messageKey: 'warning', canPost: true, requiresApproval: false })
    expect(getStrikeConsequence(ladder.reviewGated, ladder)).toMatchObject({ notify: true, messageKey: 'review_gated', canPost: true, requiresApproval: true })
    expect(getStrikeConsequence(ladder.quieted, ladder)).toMatchObject({ notify: true, messageKey: 'quieted', canPost: false, requiresApproval: false })
  })

  it('carries the points through', () => {
    expect(getStrikeConsequence(7, ladder).points).toBe(7)
  })
})

describe('tier helpers', () => {
  it('orders tiers from clean to quieted', () => {
    expect(tierIndex('clean')).toBeLessThan(tierIndex('nudge'))
    expect(tierIndex('warned')).toBeLessThan(tierIndex('quieted'))
  })

  it('names a notification kind only for notified tiers', () => {
    expect(tierNotificationKind('clean')).toBeNull()
    expect(tierNotificationKind('nudge')).toBeNull()
    expect(tierNotificationKind('warned')).toBe('moderation_warning')
    expect(tierNotificationKind('review_gated')).toBe('moderation_restriction')
    expect(tierNotificationKind('quieted')).toBe('moderation_quieted')
  })
})

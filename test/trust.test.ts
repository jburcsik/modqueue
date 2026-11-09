import { describe, expect, it } from 'vitest'
import { defaultConfig, mergeConfig } from '../src/config.js'
import { accountAgeHours, adjustTrustForReputation, calculateReputationScore, getTrustLevel, resolveTrust, trustTierFor } from '../src/trust.js'
import { NOW_MS, hoursAgo, reputation } from './helpers.js'

const trust = defaultConfig.trust
const rep = defaultConfig.reputation

describe('getTrustLevel', () => {
  it('picks the tier whose upper bound the age is strictly below', () => {
    expect(getTrustLevel(hoursAgo(0), trust, NOW_MS).level).toBe('new')
    expect(getTrustLevel(hoursAgo(47.99), trust, NOW_MS).level).toBe('new')
    expect(getTrustLevel(hoursAgo(48), trust, NOW_MS).level).toBe('restricted')
    expect(getTrustLevel(hoursAgo(7 * 24 - 0.01), trust, NOW_MS).level).toBe('restricted')
    expect(getTrustLevel(hoursAgo(7 * 24), trust, NOW_MS).level).toBe('limited')
    expect(getTrustLevel(hoursAgo(14 * 24), trust, NOW_MS).level).toBe('full')
    expect(getTrustLevel(hoursAgo(100000), trust, NOW_MS).level).toBe('full')
  })

  it('copies the tier permissions and caps', () => {
    const fresh = getTrustLevel(hoursAgo(1), trust, NOW_MS)
    expect(fresh).toMatchObject({ canReport: false, submissionsPerDay: 2, requiresApproval: true })
    expect(fresh.accountAgeHours).toBeCloseTo(1)
    const full = getTrustLevel(hoursAgo(5000), trust, NOW_MS)
    expect(full).toMatchObject({ canReport: true, submissionsPerDay: 16, requiresApproval: false })
  })

  it('treats a future creation time as age zero', () => {
    expect(accountAgeHours(hoursAgo(-5), NOW_MS)).toBe(0)
  })

  it('refuses a tier table with no final tier', () => {
    expect(() => trustTierFor(10, { ...trust, tiers: [{ level: 'new', maxAgeHours: 1, canReport: false, submissionsPerDay: 1, requiresApproval: true }] })).toThrow()
  })
})

describe('calculateReputationScore', () => {
  it('is the baseline for a user with no activity', () => {
    expect(calculateReputationScore(reputation(), rep)).toBe(rep.baseline)
  })

  it('caps each contribution', () => {
    expect(calculateReputationScore(reputation({ endorsed_posts: 100 }), rep)).toBe(rep.baseline + rep.endorsedPostCap)
    expect(calculateReputationScore(reputation({ endorsements_given: 100 }), rep)).toBe(rep.baseline + rep.endorsementGivenCap)
    expect(calculateReputationScore(reputation({ posts: 100 }), rep)).toBe(rep.baseline + rep.postCap)
    expect(calculateReputationScore(reputation({ reports_received: 100 }), rep)).toBe(rep.baseline - rep.reportReceivedCap)
  })

  it('rounds to an integer', () => {
    expect(calculateReputationScore(reputation({ endorsements_given: 1 }), rep)).toBe(41)
  })

  it('clamps to the score range', () => {
    const wide = mergeConfig(defaultConfig, { reputation: { reportReceivedCap: 1000, endorsedPostCap: 1000 } }).reputation
    expect(calculateReputationScore(reputation({ reports_received: 100 }), wide)).toBe(rep.min)
    expect(calculateReputationScore(reputation({ endorsed_posts: 100 }), wide)).toBe(rep.max)
  })
})

describe('adjustTrustForReputation', () => {
  const full = getTrustLevel(hoursAgo(5000), trust, NOW_MS)
  const restricted = getTrustLevel(hoursAgo(100), trust, NOW_MS)
  const fresh = getTrustLevel(hoursAgo(1), trust, NOW_MS)

  it('boosts the cap up to the boost cap and lifts approval beyond the first tier', () => {
    expect(adjustTrustForReputation(full, trust.boostAt, trust).submissionsPerDay).toBe(trust.boostCap)
    const boosted = adjustTrustForReputation(restricted, trust.boostAt, trust)
    expect(boosted.submissionsPerDay).toBe(restricted.submissionsPerDay * trust.boostMultiplier)
    expect(boosted.requiresApproval).toBe(false)
  })

  it('keeps approval for the first tier even when boosted', () => {
    expect(adjustTrustForReputation(fresh, 100, trust).requiresApproval).toBe(true)
  })

  it('restricts the cap down to the floor and forces approval', () => {
    const limited = getTrustLevel(hoursAgo(200), trust, NOW_MS)
    const restrictedResult = adjustTrustForReputation(limited, trust.restrictAt, trust)
    expect(restrictedResult.submissionsPerDay).toBe(limited.submissionsPerDay / trust.restrictDivisor)
    expect(restrictedResult.requiresApproval).toBe(true)
    expect(adjustTrustForReputation(fresh, 0, trust).submissionsPerDay).toBe(trust.restrictFloor)
  })

  it('leaves a middling score alone', () => {
    expect(adjustTrustForReputation(full, 50, trust)).toEqual(full)
  })
})

describe('resolveTrust', () => {
  it('returns age-only trust when the host has no reputation inputs', () => {
    expect(resolveTrust(hoursAgo(5000), null, defaultConfig, NOW_MS)).toEqual(getTrustLevel(hoursAgo(5000), trust, NOW_MS))
  })

  it('applies the reputation adjustment when inputs exist', () => {
    const result = resolveTrust(hoursAgo(5000), reputation({ reports_received: 10 }), defaultConfig, NOW_MS)
    expect(result.requiresApproval).toBe(true)
  })
})

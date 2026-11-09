import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { defaultConfig, mergeConfig } from '../src/config.js'
import { applyReachToTtl, computeReach, getNotificationPolicy, lookupStep, neutralReputationInputs, reachTier } from '../src/reach.js'
import { calculateReputationScore } from '../src/trust.js'
import { NOW_MS, USER_A, hoursAgo, reputation } from './helpers.js'

const reach = defaultConfig.reach

function compute(overrides: Parameters<typeof reputation>[0] = {}, activeStrikePoints = 0, config = defaultConfig) {
  return computeReach({ reputation: reputation(overrides), activeStrikePoints, nowMs: NOW_MS }, config)
}

describe('lookupStep', () => {
  it('returns the first row the input is strictly below, else otherwise', () => {
    const table = { steps: [{ below: 1, value: 10 }, { below: 5, value: 20 }], otherwise: 30 }
    expect(lookupStep(table, 0)).toBe(10)
    expect(lookupStep(table, 1)).toBe(20)
    expect(lookupStep(table, 4.99)).toBe(20)
    expect(lookupStep(table, 5)).toBe(30)
  })
})

describe('computeReach factors', () => {
  it('age follows the age table', () => {
    expect(compute({ account_created_at: hoursAgo(1) }).factors.age).toBe(0.5)
    expect(compute({ account_created_at: hoursAgo(48) }).factors.age).toBe(0.75)
    expect(compute({ account_created_at: hoursAgo(7 * 24) }).factors.age).toBe(0.9)
    expect(compute({ account_created_at: hoursAgo(14 * 24) }).factors.age).toBe(1)
  })

  it('reputation follows the reputation table on the computed score', () => {
    expect(compute({ reports_received: 10 }).factors.reputation).toBe(0.4)
    expect(compute().factors.reputation).toBe(0.8)
    expect(compute({ endorsed_posts: 10, endorsements_given: 20, posts: 20 }).factors.reputation).toBe(1.15)
  })

  it('strikes follow the strike table', () => {
    expect(compute({}, 0).factors.strikes).toBe(1)
    expect(compute({}, 1).factors.strikes).toBe(0.75)
    expect(compute({}, 4).factors.strikes).toBe(0.45)
    expect(compute({}, 6).factors.strikes).toBe(0.15)
    expect(compute({}, 8).factors.strikes).toBe(0.1)
  })

  it('engagement rewards endorsed posts with no reports and penalises a low ratio', () => {
    expect(compute({ endorsed_posts: 8 }).factors.engagement).toBe(1.1)
    expect(compute({ endorsed_posts: 7 }).factors.engagement).toBe(1)
    expect(compute({ endorsed_posts: 3, reports_received: 1 }).factors.engagement).toBe(1)
    expect(compute({ endorsed_posts: 4, reports_received: 2 }).factors.engagement).toBe(0.85)
  })

  it('far report is neutral for null and follows the table otherwise', () => {
    expect(compute({ far_rate: null }).factors.farReport).toBe(1)
    expect(compute({ far_rate: 0.1 }).factors.farReport).toBe(1)
    expect(compute({ far_rate: 0.3 }).factors.farReport).toBe(0.4)
    expect(compute({ far_rate: 0.6 }).factors.farReport).toBe(0.1)
  })

  it('multiplies the factors', () => {
    const result = compute({ account_created_at: hoursAgo(5000), posts: 20, endorsed_posts: 10, endorsements_given: 10 }, 5)
    expect(result.coefficient).toBeCloseTo(0.5445, 10)
    expect(result.inputs).toMatchObject({ reputationScore: 81, activeStrikePoints: 5, posts: 20, endorsedPosts: 10, endorsementsGiven: 10, reportsReceived: 0, farRate: null })
    expect(result.error).toBe(false)
    expect(result.enabled).toBe(true)
  })
})

describe('computeReach bounds and switches', () => {
  it('clamps to the configured range', () => {
    const narrow = mergeConfig(defaultConfig, { reach: { clamp: { min: 0.2, max: 1.2 } } })
    expect(compute({ account_created_at: hoursAgo(5000), posts: 50, endorsed_posts: 30, endorsements_given: 40 }, 0, narrow).coefficient).toBe(1.2)
    expect(compute({ account_created_at: hoursAgo(1), reports_received: 20, far_rate: 0.9 }, 10, narrow).coefficient).toBe(0.2)
  })

  it('returns 1.0 with neutral factors when reach is disabled', () => {
    const off = mergeConfig(defaultConfig, { reach: { enabled: false } })
    const result = compute({ reports_received: 20 }, 10, off)
    expect(result.coefficient).toBe(1)
    expect(result.enabled).toBe(false)
    expect(result.factors).toEqual({ age: 1, reputation: 1, strikes: 1, engagement: 1, farReport: 1 })
    expect(result.inputs.reportsReceived).toBe(20)
  })

  it('returns the unknown-user coefficient when there is no reputation row', () => {
    const result = computeReach({ reputation: null, activeStrikePoints: 0, nowMs: NOW_MS }, defaultConfig)
    expect(result.coefficient).toBe(reach.unknownUserCoefficient)
    expect(result.factors).toEqual({ age: 1, reputation: 1, strikes: 1, engagement: 1, farReport: 1 })
    expect(result.inputs.reputationScore).toBe(defaultConfig.reputation.baseline)
  })

  it('neutral inputs stand in for a missing host view', () => {
    const neutral = neutralReputationInputs(USER_A, hoursAgo(5000))
    expect(neutral).toMatchObject({ user_id: USER_A, posts: 0, endorsed_posts: 0, endorsements_given: 0, reports_received: 0, far_rate: null })
    expect(computeReach({ reputation: neutral, activeStrikePoints: 0, nowMs: NOW_MS }, defaultConfig).coefficient).toBe(0.8)
  })
})

describe('applyReachToTtl', () => {
  it('scales and clamps the lifetime', () => {
    expect(applyReachToTtl(24, 1, reach.ttl)).toBe(24)
    expect(applyReachToTtl(24, 0.1, reach.ttl)).toBeCloseTo(24 * reach.ttl.floorMultiplier)
    expect(applyReachToTtl(24, 1.5, reach.ttl)).toBeCloseTo(24 * reach.ttl.ceilingMultiplier)
    expect(applyReachToTtl(24, 0.5, reach.ttl)).toBe(12)
  })
})

describe('getNotificationPolicy', () => {
  it('follows the steps and caps the radius above them', () => {
    expect(getNotificationPolicy(0.1, reach.notification)).toEqual({ shouldNotify: false, radiusMultiplier: 0 })
    expect(getNotificationPolicy(0.2, reach.notification)).toEqual({ shouldNotify: true, radiusMultiplier: 0.3 })
    expect(getNotificationPolicy(0.5, reach.notification)).toEqual({ shouldNotify: true, radiusMultiplier: 0.6 })
    expect(getNotificationPolicy(1, reach.notification)).toEqual({ shouldNotify: true, radiusMultiplier: 1 })
    expect(getNotificationPolicy(1.1, reach.notification)).toEqual({ shouldNotify: true, radiusMultiplier: 1.1 })
    expect(getNotificationPolicy(1.5, reach.notification)).toEqual({ shouldNotify: true, radiusMultiplier: reach.notification.radiusCap })
  })
})

describe('reachTier', () => {
  it('labels the bands', () => {
    expect(reachTier(0.1, reach)).toBe('hidden')
    expect(reachTier(0.2, reach)).toBe('low')
    expect(reachTier(0.5, reach)).toBe('reduced')
    expect(reachTier(1, reach)).toBe('normal')
    expect(reachTier(1.1, reach)).toBe('high')
  })
})

interface ParityRow {
  name: string
  inputs: {
    account_age_hours: number
    posts: number
    endorsed_posts: number
    endorsements_given: number
    reports_received: number
    far_rate: number | null
    active_strike_points: number
  }
  expected: {
    reputation_score: number
    age_factor: number
    reputation_factor: number
    strike_factor: number
    engagement_factor: number
    far_report_factor: number
    coefficient: number
  }
}

describe('reach parity fixture', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/reach-parity.json', import.meta.url), 'utf8')) as { rows: ParityRow[] }

  it('has eight rows', () => {
    expect(fixture.rows).toHaveLength(8)
  })

  it.each(fixture.rows)('$name matches the SQL fixture', ({ inputs, expected }) => {
    const row = reputation({
      account_created_at: hoursAgo(inputs.account_age_hours),
      posts: inputs.posts,
      endorsed_posts: inputs.endorsed_posts,
      endorsements_given: inputs.endorsements_given,
      reports_received: inputs.reports_received,
      far_rate: inputs.far_rate,
    })
    const result = computeReach({ reputation: row, activeStrikePoints: inputs.active_strike_points, nowMs: NOW_MS }, defaultConfig)
    expect(calculateReputationScore(row, defaultConfig.reputation)).toBe(expected.reputation_score)
    expect(result.factors.age).toBe(expected.age_factor)
    expect(result.factors.reputation).toBe(expected.reputation_factor)
    expect(result.factors.strikes).toBe(expected.strike_factor)
    expect(result.factors.engagement).toBe(expected.engagement_factor)
    expect(result.factors.farReport).toBe(expected.far_report_factor)
    expect(result.coefficient).toBeCloseTo(expected.coefficient, 4)
  })
})

import { describe, expect, it } from 'vitest'
import { defaultConfig, mergeConfig } from '../src/config.js'
import { ROLE_ORDER, canModerate, isAdmin, roleAtLeast } from '../src/roles.js'

describe('mergeConfig', () => {
  it('deep merges plain objects and leaves the base untouched', () => {
    const merged = mergeConfig(defaultConfig, { strikes: { ladder: { quieted: 20 } }, messages: { brandName: 'Example' } })
    expect(merged.strikes.ladder).toEqual({ ...defaultConfig.strikes.ladder, quieted: 20 })
    expect(merged.strikes.weights).toEqual(defaultConfig.strikes.weights)
    expect(merged.messages.brandName).toBe('Example')
    expect(defaultConfig.strikes.ladder.quieted).not.toBe(20)
  })

  it('replaces arrays and patterns whole', () => {
    const merged = mergeConfig(defaultConfig, { trust: { tiers: [{ level: 'full', maxAgeHours: null, canReport: true, submissionsPerDay: 99, requiresApproval: false }] }, reports: { evidencePathPattern: /^x$/ } })
    expect(merged.trust.tiers).toHaveLength(1)
    expect(merged.reports.evidencePathPattern.source).toBe('^x$')
  })

  it('keeps null', () => {
    const merged = mergeConfig(defaultConfig, { settings: { updatedBy: null } })
    expect(merged.settings.updatedBy).toBeNull()
    expect(merged.settings.warnThreshold).toBe(defaultConfig.settings.warnThreshold)
  })
})

describe('config parity with settings', () => {
  it('report and appeal presets equal the settings columns', () => {
    expect(defaultConfig.rateLimits.report).toEqual({ windowSeconds: defaultConfig.settings.reportRateWindowSeconds, max: defaultConfig.settings.reportRateMax })
    expect(defaultConfig.rateLimits.appeal).toEqual({ windowSeconds: defaultConfig.settings.appealRateWindowSeconds, max: defaultConfig.settings.appealRateMax })
    expect(defaultConfig.reach.enabled).toBe(defaultConfig.settings.reachEnabled)
  })

  it('ships empty term lists and bypass off', () => {
    expect(defaultConfig.filter.blockedTerms).toEqual([])
    expect(defaultConfig.settings.autoBlockKeywords).toEqual([])
    expect(defaultConfig.rateLimits.bypass).toBe(false)
  })
})

describe('roles', () => {
  it('orders member below moderator below admin', () => {
    expect(ROLE_ORDER.member).toBeLessThan(ROLE_ORDER.moderator)
    expect(ROLE_ORDER.moderator).toBeLessThan(ROLE_ORDER.admin)
    expect(roleAtLeast('admin', 'moderator')).toBe(true)
    expect(roleAtLeast('member', 'moderator')).toBe(false)
    expect(canModerate('moderator')).toBe(true)
    expect(isAdmin('moderator')).toBe(false)
  })
})

import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../src/config.js'
import { createFixtureProvider, screened, unavailable } from '../src/provider/fixture.js'
import { decideTier, scoreContent } from '../src/scoring.js'
import { settingsWith } from './helpers.js'

const settings = defaultConfig.settings
const scoring = defaultConfig.scoring

describe('decideTier', () => {
  it('allows below the log floor', () => {
    expect(decideTier(screened({ harassment: 0.19 }), settings, scoring)).toMatchObject({ tier: 'allow', severity: null, confidence: 0.19 })
  })

  it('logs at the log floor and up to the warn threshold', () => {
    expect(decideTier(screened({ harassment: scoring.allowLogFloor }), settings, scoring)).toMatchObject({ tier: 'allow_log', severity: 'info' })
    expect(decideTier(screened({ harassment: settings.warnThreshold - 0.01 }), settings, scoring).tier).toBe('allow_log')
  })

  it('warns at the warn threshold and up to the hold threshold', () => {
    const decision = decideTier(screened({ harassment: settings.warnThreshold, other: 0.1 }), settings, scoring)
    expect(decision).toMatchObject({ tier: 'warn', severity: 'warning', flaggedCategories: ['harassment'] })
    expect(decideTier(screened({ harassment: settings.holdThreshold - 0.01 }), settings, scoring).tier).toBe('warn')
  })

  it('holds at the hold threshold', () => {
    const decision = decideTier(screened({ harassment: settings.holdThreshold }), settings, scoring)
    expect(decision).toMatchObject({ tier: 'hold', severity: 'violation', flaggedCategories: ['harassment'], confidence: settings.holdThreshold })
  })

  it('holds when the provider flags regardless of scores', () => {
    const decision = decideTier(screened({ hate: 0.1 }, true), settings, scoring)
    expect(decision).toMatchObject({ tier: 'hold', severity: 'violation', flaggedCategories: ['hate'] })
  })

  it('holds as severe strictly above the severe floor for a severe category', () => {
    const category = scoring.severeCategories[0] as string
    const held = decideTier(screened({ [category]: scoring.severeScoreFloor + 0.01 }), settings, scoring)
    expect(held).toMatchObject({ tier: 'hold', severity: 'severe' })
    expect(held.flaggedCategories).toContain(category)
    expect(decideTier(screened({ [category]: scoring.severeScoreFloor }), settings, scoring).severity).not.toBe('severe')
  })

  it('reads an unavailable provider as allow with confidence 0', () => {
    expect(decideTier(unavailable('timeout'), settings, scoring)).toEqual({
      tier: 'allow',
      severity: null,
      flaggedCategories: [],
      scores: {},
      confidence: 0,
      reason: null,
      providerUnavailable: true,
    })
  })

  it('honours tuned thresholds', () => {
    const strict = settingsWith({ warnThreshold: 0.1, holdThreshold: 0.2 })
    expect(decideTier(screened({ harassment: 0.15 }), strict, scoring).tier).toBe('warn')
    expect(decideTier(screened({ harassment: 0.2 }), strict, scoring).tier).toBe('hold')
  })
})

describe('scoreContent', () => {
  it('allows everything and skips the provider when automation is off', async () => {
    const provider = createFixtureProvider({ fallback: screened({ hate: 0.99 }, true) })
    const decision = await scoreContent('anything', settingsWith({ automationLevel: 'off' }), provider, defaultConfig)
    expect(decision.tier).toBe('allow')
    expect(provider.calls).toHaveLength(0)
  })

  it('holds on a block keyword with confidence 1 before calling the provider', async () => {
    const provider = createFixtureProvider()
    const decision = await scoreContent('Buy CHEAP widgets now', settingsWith({ autoBlockKeywords: ['cheap widgets'] }), provider, defaultConfig)
    expect(decision).toMatchObject({ tier: 'hold', severity: 'violation', confidence: 1, flaggedCategories: ['keyword_block'] })
    expect(provider.calls).toHaveLength(0)
  })

  it('escalates an allow to a warn on a warn keyword', async () => {
    const provider = createFixtureProvider({ fallback: screened({ harassment: 0.25 }) })
    const decision = await scoreContent('this has a Sketchy term', settingsWith({ autoWarnKeywords: ['sketchy'] }), provider, defaultConfig)
    expect(decision).toMatchObject({ tier: 'warn', severity: 'warning', confidence: 0.25 })
    expect(decision.flaggedCategories).toContain('keyword_warn')
  })

  it('never lowers a hold with a warn keyword', async () => {
    const provider = createFixtureProvider({ fallback: screened({ harassment: 0.9 }) })
    const decision = await scoreContent('sketchy and worse', settingsWith({ autoWarnKeywords: ['sketchy'] }), provider, defaultConfig)
    expect(decision.tier).toBe('hold')
  })

  it('allows with confidence 0 when the provider is unavailable', async () => {
    const provider = createFixtureProvider({ fallback: unavailable('api_error', 'HTTP 500') })
    const decision = await scoreContent('plain text', settings, provider, defaultConfig)
    expect(decision).toMatchObject({ tier: 'allow', confidence: 0, providerUnavailable: true })
    expect(provider.calls).toEqual(['plain text'])
  })
})

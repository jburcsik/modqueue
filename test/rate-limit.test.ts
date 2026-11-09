import { describe, expect, it, vi } from 'vitest'
import { defaultConfig } from '../src/config.js'
import { createRateLimiter, slidingWindow } from '../src/rate-limit.js'
import { NOW_MS, USER_A, makeDeps } from './helpers.js'

describe('slidingWindow', () => {
  it('allows up to max in the window and denies at max', () => {
    let stamps: number[] = []
    for (let i = 0; i < 3; i += 1) {
      const result = slidingWindow(stamps, NOW_MS + i, 60, 3)
      expect(result.allowed).toBe(true)
      stamps = result.timestamps
    }
    const denied = slidingWindow(stamps, NOW_MS + 3, 60, 3)
    expect(denied.allowed).toBe(false)
    expect(denied.timestamps).toHaveLength(3)
  })

  it('allows again once the window has passed and drops expired stamps', () => {
    const full = [NOW_MS, NOW_MS + 1, NOW_MS + 2]
    const later = slidingWindow(full, NOW_MS + 60_003, 60, 3)
    expect(later.allowed).toBe(true)
    expect(later.timestamps).toEqual([NOW_MS + 60_003])
  })
})

describe('createRateLimiter', () => {
  it('formats keys as name:identifier with the preset window and max', async () => {
    const checkRateLimit = vi.fn(async () => true)
    const limiter = createRateLimiter({ checkRateLimit }, defaultConfig.rateLimits)
    await limiter.check('report', USER_A)
    expect(checkRateLimit).toHaveBeenCalledWith(`report:${USER_A}`, defaultConfig.rateLimits.report.windowSeconds, defaultConfig.rateLimits.report.max)
    await limiter.daily(USER_A, 4)
    expect(checkRateLimit).toHaveBeenLastCalledWith(`daily:${USER_A}`, 24 * 60 * 60, 4)
  })

  it('denies at max and allows after the window on the in-memory store', async () => {
    const deps = makeDeps()
    const limiter = createRateLimiter(deps.store, deps.config.rateLimits)
    const { max, windowSeconds } = deps.config.rateLimits.submit
    for (let i = 0; i < max; i += 1) expect(await limiter.check('submit', USER_A)).toBe(true)
    expect(await limiter.check('submit', USER_A)).toBe(false)
    deps.clock.advance(windowSeconds * 1000 + 1)
    expect(await limiter.check('submit', USER_A)).toBe(true)
  })

  it('fails closed when the store throws', async () => {
    const limiter = createRateLimiter({ checkRateLimit: async () => { throw new Error('down') } }, defaultConfig.rateLimits)
    expect(await limiter.check('read', USER_A)).toBe(false)
  })

  it('allows everything when bypass is set explicitly', async () => {
    const checkRateLimit = vi.fn(async () => false)
    const limiter = createRateLimiter({ checkRateLimit }, { ...defaultConfig.rateLimits, bypass: true })
    expect(await limiter.check('submit', USER_A)).toBe(true)
    expect(checkRateLimit).not.toHaveBeenCalled()
  })
})

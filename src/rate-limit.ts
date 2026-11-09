import type { RateLimitPreset, RateLimitsConfig } from './config.js'
import type { ModerationStore } from './store.js'

const DAY_SECONDS = 24 * 60 * 60

export type RateLimitPresetName = Exclude<keyof RateLimitsConfig, 'bypass'>

export interface RateLimiter {
  /** One call against a preset for an identifier (a user id or a client address). */
  check(preset: RateLimitPresetName, identifier: string): Promise<boolean>
  /** The per-user daily submission cap from the trust tier, on its own bucket. */
  daily(userId: string, max: number): Promise<boolean>
  /** A raw check for a key that is already formatted. */
  raw(key: string, preset: RateLimitPreset): Promise<boolean>
}

/**
 * Sliding-window limiter over the store. Keys are `<name>:<identifier>`.
 * Any store error denies the call. `config.bypass` allows everything and
 * must be set explicitly by the host, never from the environment.
 */
export function createRateLimiter(store: Pick<ModerationStore, 'checkRateLimit'>, config: RateLimitsConfig): RateLimiter {
  async function raw(key: string, preset: RateLimitPreset): Promise<boolean> {
    if (config.bypass) return true
    try {
      return await store.checkRateLimit(key, preset.windowSeconds, preset.max)
    } catch {
      return false
    }
  }
  return {
    raw,
    check: (preset, identifier) => raw(`${preset}:${identifier}`, config[preset]),
    daily: (userId, max) => raw(`daily:${userId}`, { windowSeconds: DAY_SECONDS, max }),
  }
}

export interface SlidingWindowResult {
  allowed: boolean
  /** Timestamps still inside the window, including the one just recorded when allowed. */
  timestamps: number[]
}

/** Pure sliding window over call timestamps; the in-memory store's `checkRateLimit`. */
export function slidingWindow(timestamps: ReadonlyArray<number>, nowMs: number, windowSeconds: number, max: number): SlidingWindowResult {
  const cutoff = nowMs - windowSeconds * 1000
  const live = timestamps.filter((t) => t > cutoff)
  if (live.length >= max) return { allowed: false, timestamps: live }
  live.push(nowMs)
  return { allowed: true, timestamps: live }
}

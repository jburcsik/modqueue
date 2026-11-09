import type { Clock } from './store.js'

/** Wall-clock time. */
export const systemClock: Clock = { now: () => Date.now() }

export interface FixedClock extends Clock {
  /** Moves the clock forward by `ms`. */
  advance(ms: number): void
  set(ms: number): void
}

/** A clock that only moves when told to; for tests and replay. */
export function createFixedClock(startMs: number): FixedClock {
  let current = startMs
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    },
    set: (ms) => {
      current = ms
    },
  }
}

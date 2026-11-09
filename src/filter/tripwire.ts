import type { TripwireConfig } from '../config.js'
import type { TripwireResult } from '../types.js'

/**
 * Detects prompt-injection phrasing in normalized text. Detect only: a hit is
 * recorded as a `tripwire` event and never blocks. Patterns sharing a name
 * form one group; the result lists each group once.
 */
export function detectTripwire(clean: string, config: TripwireConfig): TripwireResult {
  const patterns: string[] = []
  for (const { name, pattern } of config.patterns) {
    if (clean.search(pattern) !== -1 && !patterns.includes(name)) patterns.push(name)
  }
  return { hit: patterns.length > 0, patterns }
}

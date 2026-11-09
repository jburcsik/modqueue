import { QUEUE_FILTERS, defaultConfig } from 'modqueue'
import type { QueueFilter, Severity } from 'modqueue'

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseFilter(value: string | undefined): QueueFilter {
  return (QUEUE_FILTERS as readonly string[]).includes(value ?? '') ? (value as QueueFilter) : 'open'
}

/** Option labels for the strike select, read from the ladder weights so they cannot drift. */
export function strikeOptions(): { value: Severity; label: string }[] {
  const weights = defaultConfig.strikes.weights
  return (Object.keys(weights) as Severity[]).map((severity) => {
    const w = weights[severity]
    const points = `${w.points} ${w.points === 1 ? 'point' : 'points'}`
    const life = w.decayDays === null ? 'permanent' : `${w.decayDays} days`
    return { value: severity, label: `${severity} (${points}, ${life})` }
  })
}
